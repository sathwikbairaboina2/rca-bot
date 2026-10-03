import { toIso } from "../core/time.js";
import type { Evidence, IncidentReport, QueryResult } from "../core/types.js";

export interface SlackMessage { text: string; blocks: Record<string, unknown>[] }

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MAX_SECTION = 3000;
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: text.length > MAX_SECTION ? text.slice(0, MAX_SECTION - 1) + "…" : text } });

function evidenceLine(e: Evidence, queries: QueryResult[]): string {
  const tpl = queries.find((q) => q.queryId === e.queryId)?.templateId ?? "?";
  const quote = Object.entries(e.quote).map(([k, v]) => `${k}=${v}`).join(", ");
  return `• \`${e.queryId}\` ${escapeMrkdwn(tpl)} row ${e.row}: ${escapeMrkdwn(quote)}`;
}

function allEvidence(report: IncidentReport): Evidence[] {
  return report.posted.flatMap((h) => h.evidence);
}

export function renderIncidentCard(report: IncidentReport): SlackMessage {
  const first = report.alarms[0] ?? "alarm";
  const top = report.posted[0];
  const blocks: Record<string, unknown>[] = [];

  const header = `\u{1F6A8} ${first} · ${report.service}`;
  blocks.push({ type: "header", text: { type: "plain_text", text: header.slice(0, 150) } });
  blocks.push({
    type: "context",
    elements: [{
      type: "mrkdwn",
      text: `Status: *${report.status}* · opened ${toIso(report.openedAtMs)} · model ${escapeMrkdwn(report.model)} · ${report.queries.length} queries · ${report.alarms.length} alarm(s)`,
    }],
  });

  if (report.status === "POSTED" && top) {
    blocks.push(section(`*Top hypothesis:* ${top.category} (confidence *${top.confidence}*)\n${escapeMrkdwn(top.summary)}`));
    const lines = allEvidence(report).slice(0, 5).map((e) => evidenceLine(e, report.queries));
    blocks.push(section(`*Evidence*\n${lines.join("\n")}`));
    if (report.posted.length > 1) {
      const others = report.posted.slice(1).map((h) => `${h.rank}. ${h.category} (${h.confidence}) - ${escapeMrkdwn(h.summary)}`);
      blocks.push(section(`*Other verified hypotheses*\n${others.join("\n")}`));
    }
  } else if (report.status === "BUDGET_EXHAUSTED") {
    blocks.push(section("*Budget exhausted.* The daily token cap was reached; no model calls were made."));
  } else {
    blocks.push(section(`*No verified root cause.* ${report.dropped.length} hypothesis(es) failed verification.`));
    const shown = report.queries.filter((q) => q.status === "Complete" && q.rows.length > 0).slice(0, 2);
    for (const q of shown) {
      const rows = q.rows.slice(0, 3).map((r) => escapeMrkdwn(JSON.stringify(r))).join("\n");
      blocks.push(section(`\`${q.queryId}\` ${escapeMrkdwn(q.templateId)}\n\`\`\`\n${rows}\n\`\`\``));
    }
  }

  const deploys = report.context?.deploys ?? [];
  if (deploys.length > 0) {
    const lines = deploys.map((d) => `• ${toIso(d.atMs)} ${escapeMrkdwn(d.functionName)} ${escapeMrkdwn(d.fromVersion)} → ${escapeMrkdwn(d.toVersion)}`);
    blocks.push(section(`*Deploys near the window*\n${lines.join("\n")}`));
  }

  const button = (text: string, action_id: string) => ({ type: "button", text: { type: "plain_text", text }, action_id, value: report.incidentId });
  blocks.push({ type: "actions", elements: [button("Correct", "feedback_correct"), button("Wrong", "feedback_wrong"), button("Show raw queries", "show_raw")] });

  return { text: `[${report.status}] ${first}: ${top && report.status === "POSTED" ? top.category : "no verified root cause"}`, blocks };
}

/** Plain-text version of the card for the terminal (no emoji). */
export function renderTerminal(report: IncidentReport): string {
  const out: string[] = [];
  out.push(`Incident ${report.incidentId} - ${report.service} - ${report.status}`);
  out.push(`Alarms: ${report.alarms.join(", ")}`);
  out.push(`Model: ${report.model} (${report.modelCalls} calls, ${report.usage.inputTokens} in / ${report.usage.outputTokens} out tokens), ${report.queries.length} queries run`);
  const top = report.posted[0];
  if (report.status === "POSTED" && top) {
    out.push("");
    out.push(`Top hypothesis: ${top.category} (confidence ${top.confidence})`);
    out.push(`  ${top.summary}`);
    out.push("Evidence:");
    for (const e of allEvidence(report).slice(0, 5)) {
      const tpl = report.queries.find((q) => q.queryId === e.queryId)?.templateId ?? "?";
      out.push(`  ${e.queryId} ${tpl} row ${e.row}: ${Object.entries(e.quote).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    if (report.posted.length > 1) {
      out.push("Other verified hypotheses:");
      for (const h of report.posted.slice(1)) out.push(`  ${h.rank}. ${h.category} (confidence ${h.confidence}) - ${h.summary}`);
    }
  } else if (report.status === "BUDGET_EXHAUSTED") {
    out.push("");
    out.push("Budget exhausted: the daily token cap was reached; no model calls were made.");
  } else {
    out.push("");
    out.push(`No verified root cause. ${report.dropped.length} hypothesis(es) failed verification.`);
  }
  if (report.dropped.length > 0 && report.status === "POSTED") out.push(`Dropped by the verifier: ${report.dropped.length}`);
  for (const d of report.context?.deploys ?? []) out.push(`Deploy: ${toIso(d.atMs)} ${d.functionName} ${d.fromVersion} -> ${d.toVersion}`);
  for (const n of report.notes) out.push(`Note: ${n}`);
  return out.join("\n");
}
