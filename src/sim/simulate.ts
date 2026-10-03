import { activeFault, type FaultFlag } from "../chaos/flag.js";
import type { ScenarioDef } from "../chaos/chaos.js";
import { buildAlarmStateChangeEvent } from "../core/alarmEvent.js";
import { chance, intBetween, mulberry32 } from "../core/rng.js";
import { MINUTE_MS, minuteFloor, toIso } from "../core/time.js";
import type { DeployEvent, GroundTruth, LogEvent, MetricSeries } from "../core/types.js";
import { createLogger } from "../demo/logger.js";
import { handleOrder, type DemoDeps } from "../demo/orders.js";
import { handleCharge } from "../demo/payments.js";
import { coldStart } from "../demo/platform.js";

export const DEMO_LOG_GROUPS = { orders: "/aws/lambda/rca-demo-orders", payments: "/aws/lambda/rca-demo-payments" } as const;
export const ALARMS = [
  // Same metrics the CDK alarms use (API Gateway 5XXError Average = 5xx rate; Latency p99), see infra.
  { name: "orders-5xx-rate", metric: "5XXError", namespace: "AWS/ApiGateway", threshold: 0.05, unit: "Ratio" },
  { name: "orders-p99-latency", metric: "Latency", namespace: "AWS/ApiGateway", threshold: 2000, unit: "Milliseconds" },
] as const;

export interface SimOptions { seed: number; startMs?: number; rps?: number; baselineMin?: number; faultMin?: number }
export interface SimulationResult {
  scenario: ScenarioDef;
  seed: number;
  startMs: number;
  faultStartMs: number;
  faultEndMs: number;
  logs: LogEvent[]; // sorted by timestamp
  metrics: MetricSeries[]; // "5XXError" (rate), "Latency" (p99 ms), "Count" (requests), per minute
  alarmEvents: unknown[]; // EventBridge-shaped, in firing order
  deploys: DeployEvent[];
  truth: GroundTruth;
  logGroups: string[]; // [orders, payments]
}

const ORDERS_VERSION = "17";

function reportMessage(requestId: string, durationMs: number, initMs: number | undefined, maxMem: number): string {
  const billed = Math.ceil(durationMs);
  let m = `REPORT RequestId: ${requestId}\tDuration: ${durationMs.toFixed(2)} ms\tBilled Duration: ${billed} ms\tMemory Size: 256 MB\tMax Memory Used: ${maxMem} MB`;
  if (initMs !== undefined) m += `\tInit Duration: ${initMs.toFixed(2)} ms`;
  return m;
}

function p99(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(0.99 * s.length) - 1))]!;
}

export async function simulate(scenario: ScenarioDef, opts: SimOptions): Promise<SimulationResult> {
  const startMs = opts.startMs ?? Date.UTC(2026, 9, 3, 9, 30);
  const rps = opts.rps ?? 2;
  const baselineMin = opts.baselineMin ?? 20;
  const faultMin = opts.faultMin ?? 10;
  const faultStartMs = startMs + baselineMin * MINUTE_MS;
  const faultEndMs = faultStartMs + faultMin * MINUTE_MS;
  const rng = mulberry32(opts.seed);
  const flag: FaultFlag = { scenarioId: scenario.id, fault: scenario.fault, params: scenario.params, until: toIso(faultEndMs) };
  const total = (baselineMin + faultMin) * 60 * rps;
  const paymentsDeployMs = startMs + 5 * MINUTE_MS;

  const logs: LogEvent[] = [];
  const e2e: { t: number; latency: number; is5xx: boolean }[] = [];
  const hex = () => intBetween(rng, 0, 0xffffffff).toString(16).padStart(8, "0");

  for (let i = 0; i < total; i++) {
    const reqStart = startMs + Math.floor(i * (1000 / rps)) + intBetween(rng, 0, 400);
    const fault = reqStart >= faultStartMs ? activeFault(flag, reqStart) : null;
    const ordersVersion = fault?.fault === "bad_deploy" ? String(fault.params.version) : ORDERS_VERSION;
    const paymentsVersion = reqStart >= paymentsDeployMs ? "42" : "41";
    const date = new Date(reqStart).toISOString().slice(0, 10).replace(/-/g, "/");
    const ordersStream = `${date}/[${ordersVersion}]${hex()}`;
    const paymentsStream = `${date}/[${paymentsVersion}]${hex()}`;
    const ordersReqId = `o-${opts.seed}-${i}`;
    const paymentsReqId = `p-${opts.seed}-${i}`;

    const req = {
      orderId: `o-${opts.seed}-${i}`,
      customerEmail: `user${i % 500}@example.com`,
      quantity: chance(rng, 0.005) ? 0 : intBetween(rng, 1, 5),
      giftWrap: chance(rng, 0.35),
      amountCents: intBetween(rng, 500, 20000),
    };

    const cold = coldStart(fault, rng);
    let ordersT = reqStart + (cold.initMs ?? 0);
    const handlerStart = ordersT;
    const ordersClock = { now: () => ordersT, advance: (ms: number) => { ordersT += ms; } };
    const pushOrders = (message: string, ts: number, fields?: LogEvent["fields"]) => {
      logs.push({ timestamp: ts, logGroup: DEMO_LOG_GROUPS.orders, logStream: ordersStream, message, ...(fields ? { fields } : {}) });
    };

    const callPayments: DemoDeps["callPayments"] = async (r) => {
      const payStart = ordersClock.now();
      let payT = payStart;
      const payClock = { now: () => payT, advance: (ms: number) => { payT += ms; } };
      const payCold = coldStart(null, rng);
      const payLog = createLogger({
        service: "payments", functionVersion: paymentsVersion, requestId: paymentsReqId, now: payClock.now,
        sink: (line) => logs.push({ timestamp: payClock.now(), logGroup: DEMO_LOG_GROUPS.payments, logStream: paymentsStream, message: line }),
      });
      const out = await handleCharge(r, { log: payLog, rng, fault });
      const fields: Record<string, string | number> = {
        "@type": "REPORT", "@requestId": paymentsReqId, "@duration": out.latencyMs, "@billedDuration": Math.ceil(out.latencyMs),
        "@memorySize": 256, "@maxMemoryUsed": intBetween(rng, 70, 120),
      };
      if (payCold.cold) fields["@initDuration"] = payCold.initMs!;
      logs.push({
        timestamp: payStart + out.latencyMs, logGroup: DEMO_LOG_GROUPS.payments, logStream: paymentsStream,
        message: reportMessage(paymentsReqId, out.latencyMs, payCold.cold ? payCold.initMs : undefined, fields["@maxMemoryUsed"] as number),
        fields,
      });
      return { status: out.status, latencyMs: out.latencyMs + (payCold.initMs ?? 0) };
    };

    const log = createLogger({
      service: "orders", functionVersion: ordersVersion, requestId: ordersReqId, now: ordersClock.now,
      sink: (line) => pushOrders(line, ordersClock.now()),
    });
    const outcome = await handleOrder(req, {
      log, rng, clock: ordersClock, fault, functionVersion: ordersVersion, putOrder: async () => {}, callPayments,
    });

    const endTs = handlerStart + outcome.durationMs;
    if (outcome.timedOut) pushOrders(`${toIso(endTs)} ${ordersReqId} Task timed out after 6.00 seconds`, endTs);
    const maxMem = intBetween(rng, 70, 120);
    const fields: Record<string, string | number> = {
      "@type": "REPORT", "@requestId": ordersReqId, "@duration": outcome.durationMs, "@billedDuration": Math.ceil(outcome.durationMs),
      "@memorySize": 256, "@maxMemoryUsed": maxMem,
    };
    if (cold.cold) fields["@initDuration"] = cold.initMs!;
    pushOrders(reportMessage(ordersReqId, outcome.durationMs, cold.cold ? cold.initMs : undefined, maxMem), endTs, fields);

    e2e.push({ t: reqStart, latency: (cold.initMs ?? 0) + outcome.durationMs + 5, is5xx: outcome.statusCode >= 500 });
  }

  logs.sort((a, b) => a.timestamp - b.timestamp);

  // Per-minute metrics, bucketed by request start.
  const buckets = new Map<number, { latencies: number[]; errors: number }>();
  for (const r of e2e) {
    const k = minuteFloor(r.t);
    let b = buckets.get(k);
    if (!b) { b = { latencies: [], errors: 0 }; buckets.set(k, b); }
    b.latencies.push(r.latency);
    if (r.is5xx) b.errors++;
  }
  const minutes = [...buckets.keys()].sort((a, b) => a - b);
  const metrics: MetricSeries[] = [
    { name: "5XXError", unit: "Ratio", points: minutes.map((m) => ({ tMs: m, value: buckets.get(m)!.errors / buckets.get(m)!.latencies.length })) },
    { name: "Latency", unit: "Milliseconds", points: minutes.map((m) => ({ tMs: m, value: p99(buckets.get(m)!.latencies) })) },
    { name: "Count", unit: "Count", points: minutes.map((m) => ({ tMs: m, value: buckets.get(m)!.latencies.length })) },
  ];

  // Alarm rule: 3 consecutive 1-minute periods breaching; fires once per alarm.
  const alarmEvents: { timeMs: number; event: unknown }[] = [];
  for (const alarm of ALARMS) {
    const series = metrics.find((m) => m.name === alarm.metric)!.points;
    for (let i = 2; i < series.length; i++) {
      const trio = series.slice(i - 2, i + 1);
      const contiguous = trio[1]!.tMs - trio[0]!.tMs === MINUTE_MS && trio[2]!.tMs - trio[1]!.tMs === MINUTE_MS;
      if (contiguous && trio.every((p) => p.value > alarm.threshold)) {
        const timeMs = trio[2]!.tMs + MINUTE_MS;
        alarmEvents.push({
          timeMs,
          event: buildAlarmStateChangeEvent({
            alarmName: alarm.name, state: "ALARM", timeMs,
            reason: `Threshold Crossed: 3 datapoints [${trio.map((p) => Number(p.value.toFixed(3))).join(", ")}] were greater than the threshold (${alarm.threshold}).`,
            metricNamespace: alarm.namespace, metricName: alarm.metric,
          }),
        });
        break;
      }
    }
  }
  alarmEvents.sort((a, b) => a.timeMs - b.timeMs);

  const deploys: DeployEvent[] = [{ atMs: paymentsDeployMs, functionName: "rca-demo-payments", fromVersion: "41", toVersion: "42" }];
  if (scenario.fault === "bad_deploy") {
    deploys.push({ atMs: faultStartMs, functionName: "rca-demo-orders", fromVersion: ORDERS_VERSION, toVersion: String(scenario.params.version) });
  }

  return {
    scenario, seed: opts.seed, startMs, faultStartMs, faultEndMs, logs, metrics,
    alarmEvents: alarmEvents.map((a) => a.event), deploys,
    truth: { scenarioId: scenario.id, fault: scenario.fault, category: scenario.expectedCategory },
    logGroups: [DEMO_LOG_GROUPS.orders, DEMO_LOG_GROUPS.payments],
  };
}
