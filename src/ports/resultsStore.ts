import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { QueryResult } from "../core/types.js";

export interface ResultsStore {
  put(incidentId: string, r: QueryResult): Promise<string>;
  list(incidentId: string): Promise<QueryResult[]>;
}

function queryNumber(queryId: string): number {
  return Number(queryId.replace(/^\D+/, "")) || 0;
}

export class MemoryResultsStore implements ResultsStore {
  private readonly byIncident = new Map<string, Map<string, QueryResult>>();

  async put(incidentId: string, r: QueryResult): Promise<string> {
    let m = this.byIncident.get(incidentId);
    if (!m) { m = new Map(); this.byIncident.set(incidentId, m); }
    m.set(r.queryId, r);
    return `memory://incidents/${incidentId}/${r.queryId}.json`;
  }

  async list(incidentId: string): Promise<QueryResult[]> {
    return [...(this.byIncident.get(incidentId)?.values() ?? [])].sort((a, b) => queryNumber(a.queryId) - queryNumber(b.queryId));
  }
}

/** key: incidents/<incidentId>/<queryId>.json */
export class S3ResultsStore implements ResultsStore {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}

  async put(incidentId: string, r: QueryResult): Promise<string> {
    const Key = `incidents/${incidentId}/${r.queryId}.json`;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key, Body: JSON.stringify(r), ContentType: "application/json" }));
    return Key;
  }

  async list(incidentId: string): Promise<QueryResult[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `incidents/${incidentId}/`, ContinuationToken: token }),
      );
      for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    const out: QueryResult[] = [];
    for (const Key of keys) {
      const got = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key }));
      const text = await got.Body!.transformToString();
      out.push(JSON.parse(text) as QueryResult);
    }
    return out.sort((a, b) => queryNumber(a.queryId) - queryNumber(b.queryId));
  }
}
