import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DroppedHypothesis, IncidentStatus, VerifiedHypothesis } from "../core/types.js";
import { toIso } from "../core/time.js";
import type { BudgetState, IncidentMeta, IncidentStore, OpenResult } from "./incidentStore.js";

const THIRTY_DAYS_S = 30 * 24 * 3600;

function errName(e: unknown): string {
  return (e as { name?: string } | null)?.name ?? "";
}

/** DynamoDB single-table implementation of the incident store (ADR 0006). TTL attribute `expiresAt` is epoch seconds. */
export class DynamoIncidentStore implements IncidentStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly now: () => number;

  constructor(o: { doc: DynamoDBDocumentClient; tableName: string; now?: () => number }) {
    this.doc = o.doc;
    this.tableName = o.tableName;
    this.now = o.now ?? Date.now;
  }

  async openIncident(meta: IncidentMeta, opts: { nowMs: number; windowMs: number; queriesAllowed: number }): Promise<OpenResult> {
    const nowSec = Math.floor(opts.nowMs / 1000);
    const expiresAt = nowSec + THIRTY_DAYS_S;
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { pk: `SVC#${meta.service}`, sk: "OPEN", incidentId: meta.incidentId, expiresAt: Math.ceil((opts.nowMs + opts.windowMs) / 1000) },
                ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :nowSec",
                ExpressionAttributeValues: { ":nowSec": nowSec },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `INC#${meta.incidentId}`, sk: "META", service: meta.service, alarms: meta.alarms,
                  openedAt: toIso(meta.openedAtMs), status: meta.status, expiresAt,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `INC#${meta.incidentId}`, sk: "BUDGET", queriesAllowed: opts.queriesAllowed, queriesUsed: 0,
                  bytesScanned: 0, tokensIn: 0, tokensOut: 0, expiresAt,
                },
              },
            },
          ],
        }),
      );
      return { opened: true };
    } catch (e) {
      const reasons = (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
      if (errName(e) === "TransactionCanceledException" && reasons?.[0]?.Code === "ConditionalCheckFailed") {
        const got = await this.doc.send(
          new GetCommand({ TableName: this.tableName, Key: { pk: `SVC#${meta.service}`, sk: "OPEN" }, ConsistentRead: true }),
        );
        return { opened: false, incidentId: String(got.Item?.incidentId) };
      }
      throw e;
    }
  }

  async appendAlarm(incidentId: string, alarmName: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: `INC#${incidentId}`, sk: "META" },
        UpdateExpression: "SET alarms = list_append(if_not_exists(alarms, :empty), :a)",
        ExpressionAttributeValues: { ":empty": [], ":a": [alarmName] },
      }),
    );
  }

  async consumeQueries(incidentId: string, n: number): Promise<number> {
    const Key = { pk: `INC#${incidentId}`, sk: "BUDGET" };
    for (let attempt = 0; attempt < 5; attempt++) {
      const got = await this.doc.send(new GetCommand({ TableName: this.tableName, Key, ConsistentRead: true }));
      const used = Number(got.Item?.queriesUsed ?? 0);
      const allowed = Number(got.Item?.queriesAllowed ?? 0);
      const grant = Math.min(n, allowed - used);
      if (grant <= 0) return 0;
      try {
        await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key,
            UpdateExpression: "SET queriesUsed = :new",
            ConditionExpression: "queriesUsed = :seen",
            ExpressionAttributeValues: { ":new": used + grant, ":seen": used },
          }),
        );
        return grant;
      } catch (e) {
        if (errName(e) !== "ConditionalCheckFailedException") throw e;
      }
    }
    return 0;
  }

  async addUsage(incidentId: string, u: { tokensIn?: number; tokensOut?: number; bytesScanned?: number }): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: `INC#${incidentId}`, sk: "BUDGET" },
        UpdateExpression: "ADD tokensIn :i, tokensOut :o, bytesScanned :b",
        ExpressionAttributeValues: { ":i": u.tokensIn ?? 0, ":o": u.tokensOut ?? 0, ":b": u.bytesScanned ?? 0 },
      }),
    );
  }

  async reserveDailyTokens(day: string, tokens: number, cap: number): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `DAY#${day}`, sk: "TOKENS" },
          UpdateExpression: "ADD used :n SET expiresAt = :exp",
          ConditionExpression: "attribute_not_exists(used) OR used <= :limit",
          ExpressionAttributeValues: { ":n": tokens, ":exp": Math.floor(this.now() / 1000) + 3 * 24 * 3600, ":limit": cap - tokens },
        }),
      );
      return true;
    } catch (e) {
      if (errName(e) === "ConditionalCheckFailedException") return false;
      throw e;
    }
  }

  async setStatus(incidentId: string, status: IncidentStatus): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: `INC#${incidentId}`, sk: "META" },
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": status },
      }),
    );
  }

  async saveHypotheses(incidentId: string, verified: VerifiedHypothesis[], dropped: DroppedHypothesis[]): Promise<void> {
    const pk = `INC#${incidentId}`;
    for (const h of verified) {
      await this.doc.send(new PutCommand({ TableName: this.tableName, Item: { pk, sk: `HYP#${h.rank}`, verified: true, ...h } }));
    }
    for (const [i, d] of dropped.entries()) {
      await this.doc.send(
        new PutCommand({ TableName: this.tableName, Item: { pk, sk: `HYP#X${i}`, verified: false, droppedReason: d.reason, hypothesis: d.hypothesis } }),
      );
    }
  }

  async getIncident(incidentId: string): Promise<{ meta: IncidentMeta; budget: BudgetState } | null> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": `INC#${incidentId}` },
        ConsistentRead: true,
      }),
    );
    const items = r.Items ?? [];
    const m = items.find((i) => i.sk === "META");
    if (!m) return null;
    const b = items.find((i) => i.sk === "BUDGET") ?? {};
    return {
      meta: { incidentId, service: m.service, alarms: m.alarms ?? [], openedAtMs: Date.parse(m.openedAt), status: m.status },
      budget: {
        queriesAllowed: Number(b.queriesAllowed ?? 0), queriesUsed: Number(b.queriesUsed ?? 0), bytesScanned: Number(b.bytesScanned ?? 0),
        tokensIn: Number(b.tokensIn ?? 0), tokensOut: Number(b.tokensOut ?? 0),
      },
    };
  }
}
