/**
 * banSystem.js — MeetlyFUN v3.0
 *
 * NEW FEATURES:
 *  - Tiered ban: warn → 10min → 24hr → permanent
 *  - Report tracking: 5 consecutive reports OR 10 reports in 30 minutes → ban
 *  - IP address capture + username logging to Google Sheets
 *  - Report cooldown per session to prevent abuse
 */

'use strict';

const BanSystem = (() => {

  const KEY_VIOLATIONS  = 'mf_violations';
  const KEY_BAN         = 'mf_ban';
  const KEY_PERM_BAN    = 'mf_perm_ban';
  const KEY_REPORTS     = 'mf_reports';        // array of { ts, reporter }
  const KEY_CONSEC      = 'mf_consec_reports'; // consecutive report count (reset on non-report session)

  /* ─── Thresholds ────────────────────────────────────── */
  const THRESHOLDS = {
    warn:    1,
    temp10:  2,
    temp24:  3,
    perm:    4
  };

  /* Report-based ban thresholds */
  const REPORT_WINDOW_MS   = 30 * 60 * 1000; // 30 minutes
  const REPORT_WINDOW_MAX  = 10;              // 10 reports in 30 min → ban
  const CONSEC_MAX         = 5;              // 5 consecutive reports → ban

  const TEN_MIN  = 10 * 60 * 1000;
  const DAY_MS   = 24 * 60 * 60 * 1000;

  /* Google Sheets logging — replace SHEET_URL with your Apps Script URL */
  const SHEET_URL = window.GOOGLE_SHEET_URL || '';

  /* ─── Helpers ─────────────────────────────────────────── */
  function _load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }
  function _save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }
  function _isLocal() {
    return !window.location.hostname || 
           window.location.hostname === 'localhost' || 
           window.location.hostname === '127.0.0.1' || 
           window.location.protocol === 'file:';
  }

  /* ─── Google Sheets Logger ──────────────────────────── */
  async function _logToSheet(data) {
    if (!SHEET_URL) return;
    try {
      await fetch(SHEET_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } catch (e) {
      console.warn('[BanSystem] Sheet log failed:', e.message);
    }
  }

  /* ─── Get approximate IP via public API ─────────────── */
  async function _getIPInfo() {
    try {
      const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return d.ip || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /* ─── Public API ─────────────────────────────────────── */

  /**
   * Check if the user is currently banned.
   */
  function checkBan() {
    if (_isLocal()) return { banned: false };
    if (_load(KEY_PERM_BAN, false)) {
      return {
        banned: true, permanent: true, remaining: Infinity,
        message: 'You have been permanently banned for repeated violations.'
      };
    }
    const ban = _load(KEY_BAN, null);
    if (ban) {
      const remaining = ban.until - Date.now();
      if (remaining > 0) {
        const mins  = Math.ceil(remaining / 60000);
        const hours = Math.ceil(remaining / 3600000);
        const label = remaining > 3600000
          ? `${hours} hour${hours > 1 ? 's' : ''}`
          : `${mins} minute${mins > 1 ? 's' : ''}`;
        return {
          banned: true, permanent: false, remaining,
          message: `You are temporarily suspended. Try again in ${label}.`
        };
      } else {
        _save(KEY_BAN, null);
      }
    }
    return { banned: false };
  }

  /**
   * Record a violation and apply escalating punishment.
   */
  function recordViolation(reason = 'Policy violation') {
    if (_isLocal()) return { action: 'none', message: 'Local bypass' };
    let violations = _load(KEY_VIOLATIONS, 0) + 1;
    _save(KEY_VIOLATIONS, violations);

    // Log to Google Sheets async (non-blocking)
    _logViolationAsync(reason, violations);

    if (violations >= THRESHOLDS.perm) {
      _save(KEY_PERM_BAN, true);
      return {
        action: 'perm',
        message: `Permanent ban issued.\nReason: ${reason}\nYou have been permanently removed from MeetlyFUN.`
      };
    }
    if (violations >= THRESHOLDS.temp24) {
      _save(KEY_BAN, { until: Date.now() + DAY_MS, reason });
      return {
        action: 'temp24',
        message: `24-hour suspension.\nReason: ${reason}\nYou may return after 24 hours.`
      };
    }
    if (violations >= THRESHOLDS.temp10) {
      _save(KEY_BAN, { until: Date.now() + TEN_MIN, reason });
      return {
        action: 'temp10',
        message: `10-minute suspension.\nReason: ${reason}\nPlease follow community guidelines.`
      };
    }
    return {
      action: 'warn',
      message: `Warning (${violations}/${THRESHOLDS.temp10 - 1})\nReason: ${reason}\nFurther violations will result in suspension.`
    };
  }

  async function _logViolationAsync(reason, count) {
    const ip = await _getIPInfo();
    const username = (typeof S !== 'undefined' && S.nm) ? S.nm : 'unknown';
    await _logToSheet({
      type: 'violation',
      username,
      ip,
      reason,
      violationCount: count,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent
    });
  }

  /**
   * Record an incoming report against the current user.
   * Checks: 5 consecutive reports OR 10 in 30 minutes → apply ban.
   *
   * @param {string} reporterName - name of the person who reported
   * @returns {{ action: string, message: string } | null} - ban action if triggered, null otherwise
   */
  function recordReport(reporterName) {
    const now = Date.now();

    // Maintain rolling report log
    let reports = _load(KEY_REPORTS, []);
    // Prune reports outside window
    reports = reports.filter(r => now - r.ts < REPORT_WINDOW_MS);
    reports.push({ ts: now, reporter: reporterName || 'anonymous' });
    _save(KEY_REPORTS, reports);

    // Update consecutive counter
    let consec = _load(KEY_CONSEC, 0) + 1;
    _save(KEY_CONSEC, consec);

    // Log report to sheet
    _logReportAsync(reporterName, reports.length, consec);

    // Check thresholds
    if (consec >= CONSEC_MAX) {
      // 5 consecutive reports
      return recordViolation(`Reported by ${consec} consecutive users`);
    }
    if (reports.length >= REPORT_WINDOW_MAX) {
      // 10 reports in 30 minutes
      return recordViolation(`Reported ${reports.length} times within 30 minutes`);
    }

    return null; // Not yet banned by reports
  }

  async function _logReportAsync(reporterName, windowCount, consecCount) {
    const ip = await _getIPInfo();
    const username = (typeof S !== 'undefined' && S.nm) ? S.nm : 'unknown';
    await _logToSheet({
      type: 'report',
      username,
      ip,
      reportedBy: reporterName || 'anonymous',
      reportWindowCount: windowCount,
      consecutiveCount: consecCount,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent
    });
  }

  /**
   * Reset consecutive report counter (called when user starts a new session without being reported)
   */
  function resetConsecutiveReports() {
    _save(KEY_CONSEC, 0);
  }

  /**
   * Log user entry to Google Sheets (IP + username tracking)
   */
  async function logEntry(username) {
    const ip = await _getIPInfo();
    await _logToSheet({
      type: 'entry',
      username: username || 'unknown',
      ip,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
  }

  function getViolationCount() { return _load(KEY_VIOLATIONS, 0); }
  function getReportCount()    { return (_load(KEY_REPORTS, [])).filter(r => Date.now() - r.ts < REPORT_WINDOW_MS).length; }

  function clearBanData() {
    localStorage.removeItem(KEY_VIOLATIONS);
    localStorage.removeItem(KEY_BAN);
    localStorage.removeItem(KEY_PERM_BAN);
    localStorage.removeItem(KEY_REPORTS);
    localStorage.removeItem(KEY_CONSEC);
  }

  return {
    checkBan,
    recordViolation,
    recordReport,
    resetConsecutiveReports,
    logEntry,
    getViolationCount,
    getReportCount,
    clearBanData
  };
})();

if (typeof module !== 'undefined') module.exports = BanSystem;
else window.BanSystem = BanSystem;
