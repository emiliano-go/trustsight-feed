// Daily scan rollup and retention.  The Worker has no loops over arbitrary
// days here: every statement is one grouped SQL operation over rows older than
// the retention boundary, so a busy AUR cannot turn the cron into a long walk.

export const SCAN_RETENTION_DAYS = 30

function boundarySeconds(days = SCAN_RETENTION_DAYS, now = Date.now()) {
  const date = new Date(now)
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  return Math.floor((start - days * 86400000) / 1000)
}

/** Squash complete old days into scan_daily_* and delete their raw rows. */
export async function rollupScans(env, days = SCAN_RETENTION_DAYS) {
  const cutoff = boundarySeconds(days)
  const statements = [
    env.DB.prepare(
      `INSERT INTO scan_daily_totals
         (day, cycles, attempted, succeeded, fetch_failed, not_vetted,
          vanished, reserved, with_diff, alerts, score_sum, score_count)
       SELECT date(time, 'unixepoch') AS day,
              COUNT(DISTINCT cycle_id),
              COUNT(*),
              COALESCE(SUM(status = 'ok'), 0),
              COALESCE(SUM(status = 'fetch_failed'), 0),
              COALESCE(SUM(status = 'not_vetted'), 0),
              COALESCE(SUM(status = 'vanished'), 0),
              COALESCE(SUM(status = 'reserved'), 0),
              COALESCE(SUM(has_diff), 0),
              0,
              COALESCE(SUM(score), 0),
              COALESCE(SUM(score IS NOT NULL), 0)
         FROM scan_events WHERE time < ?
        GROUP BY day
       ON CONFLICT(day) DO UPDATE SET
         cycles=excluded.cycles, attempted=excluded.attempted,
         succeeded=excluded.succeeded, fetch_failed=excluded.fetch_failed,
         not_vetted=excluded.not_vetted, vanished=excluded.vanished,
         reserved=excluded.reserved, with_diff=excluded.with_diff,
         score_sum=excluded.score_sum, score_count=excluded.score_count`
    ).bind(cutoff),
    env.DB.prepare(
      `UPDATE scan_daily_totals SET alerts = COALESCE((
         SELECT SUM(alerts) FROM scan_cycles
          WHERE substr(started_at, 1, 10) = scan_daily_totals.day), 0)
        WHERE day < date(?, 'unixepoch')`
    ).bind(cutoff),
    env.DB.prepare(
      `INSERT INTO scan_daily_risks (day, risk, count)
       SELECT date(time, 'unixepoch'), risk, COUNT(*)
         FROM scan_events WHERE time < ? GROUP BY 1, 2
       ON CONFLICT(day, risk) DO UPDATE SET count=excluded.count`
    ).bind(cutoff),
    env.DB.prepare(
      `INSERT INTO scan_daily_rules (day, rule_id, severity, count)
       SELECT date(time, 'unixepoch'), rule_id, MAX(severity), COUNT(*)
         FROM scan_rule_events WHERE time < ? GROUP BY 1, 2
       ON CONFLICT(day, rule_id) DO UPDATE SET
         severity=excluded.severity, count=excluded.count`
    ).bind(cutoff),
    env.DB.prepare(
      `INSERT INTO scan_daily_scores (day, bucket, count)
       SELECT date(time, 'unixepoch'), (score / 10) * 10, COUNT(*)
         FROM scan_events WHERE time < ? AND score IS NOT NULL GROUP BY 1, 2
       ON CONFLICT(day, bucket) DO UPDATE SET count=excluded.count`
    ).bind(cutoff),
    env.DB.prepare(
      `INSERT INTO scan_daily_packages
         (day, package, scans, max_score, has_diff)
       SELECT date(time, 'unixepoch'), package, COUNT(*),
              COALESCE(MAX(score), 0), COALESCE(MAX(has_diff), 0)
         FROM scan_events WHERE time < ? GROUP BY 1, 2
       ON CONFLICT(day, package) DO UPDATE SET
         scans=excluded.scans, max_score=excluded.max_score,
         has_diff=excluded.has_diff`
    ).bind(cutoff),
  ]
  await env.DB.batch(statements)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM scan_rule_events WHERE time < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM scan_events WHERE time < ?').bind(cutoff),
  ])
  return { retention_days: days, cutoff }
}
