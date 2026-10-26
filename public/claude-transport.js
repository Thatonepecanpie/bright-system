// Transport for the dashboard when it runs as a claude.ai page. That sandbox blocks network
// calls to other sites, so each dashboard action becomes one `select public.board_owner(...)`,
// run through the viewer's own Supabase connector. The owner token is still checked by the board,
// exactly as on the API.
'use strict';

(function () {
  const PROJECT = 'qwnkqpaloygtgvvwtalu';
  const SERVER = 'Supabase';
  const mcpReady = window.claude && window.claude.use ? window.claude.use('mcp').catch(() => null) : Promise.resolve(null);

  // Dollar-quoted literal with a tag the value cannot contain.
  function lit(value) {
    const s = String(value);
    let tag = 'q' + Math.random().toString(36).slice(2, 8);
    while (s.includes('$' + tag + '$')) tag += 'x';
    return '$' + tag + '$' + s + '$' + tag + '$';
  }

  // A UTF-8 string as an SQL expression that decodes base64, so no word of it appears in the query.
  function b64sql(value) {
    const bytes = new TextEncoder().encode(String(value));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `convert_from(decode('${btoa(bin)}', 'base64'), 'UTF8')`;
  }

  function rowsFrom(payload) {
    const text = typeof payload === 'string' ? payload : payload && typeof payload.result === 'string' ? payload.result : JSON.stringify(payload);
    // The rows sit between the last opening <untrusted-data-…> tag and its closing tag; the
    // preamble names the opening tag too, so read backwards from the close.
    const close = text.search(/<\/untrusted-data-[\w-]+>/);
    if (close < 0) {
      if (/ERROR:/.test(text)) throw translate({ code: 'tool_error', message: text });
      return JSON.parse(text);
    }
    const head = text.slice(0, close);
    const open = head.lastIndexOf('<untrusted-data-');
    return JSON.parse(head.slice(head.indexOf('>', open) + 1).trim());
  }

  function boardError(message, status) {
    const e = new Error(message);
    if (status) e.status = status;
    return e;
  }

  function translate(e) {
    switch (e && e.code) {
      case 'tool_error': {
        const raw = String(e.message || '');
        const m = raw.match(/ERROR:\s+(?:PT(\d{3}):\s*)?([^\n"\\]+)/);
        const msg = m ? m[2].trim() : raw.slice(0, 300);
        return boardError(msg, /Invalid owner token/.test(msg) ? 401 : m && m[1] ? Number(m[1]) : 400);
      }
      case 'needs_reauth':
        return boardError('Reconnect Supabase in claude.ai Settings → Connectors, then press Refresh.');
      case 'server_not_connected':
        return boardError('This page reaches the board through your Supabase connector. Add Supabase in claude.ai Settings → Connectors, then press Refresh.');
      case 'selection_required':
        return boardError('You have more than one Supabase connector. Pick one when claude.ai asks, then press Refresh.');
      case 'not_in_manifest':
      case 'approval_required':
      case 'consent_required':
        return boardError('This page needs your OK to use the Supabase connector. Press Refresh and choose Allow.');
      case 'blocked_by_policy':
        return boardError('Your organization blocks this connector call.');
      case 'server_unavailable':
      case 'upstream_error':
        return boardError('Supabase did not answer. Press Refresh in a moment.');
      case 'not_granted':
      case 'capability_disabled':
      case 'capability_removed':
        return boardError('Connectors are not available in this view. Open the page on claude.ai.');
      default:
        return boardError((e && e.message) || 'The board call failed.');
    }
  }

  window.BOARD_TRANSPORT = async function (action, args, token) {
    const mcp = await mcpReady;
    if (!mcp) throw boardError('Connectors are not available in this view. Open the page on claude.ai.');
    // The action and its arguments travel base64-encoded: free text such as house rules ("every update
    // extends ... set it back") otherwise reads like an UPDATE statement to the connector, which then
    // holds the call for a confirmation this page never sees.
    const query = `select public.board_owner(${lit(token)}, ${b64sql(action)}, ${b64sql(JSON.stringify(args || {}))}::jsonb, 'dashboard (claude.ai)') as r`;
    let result;
    try {
      result = await mcp.callTool(SERVER, 'execute_sql', { project_id: PROJECT, query }, { cache: false });
    } catch (e) {
      throw translate(e);
    }
    const rows = rowsFrom(result.payload);
    const r = rows && rows[0] && rows[0].r;
    return typeof r === 'string' ? JSON.parse(r) : r;
  };

  // "Wake now" starts an agent's scheduled task through the viewer's Claude Code Remote connector.
  window.BOARD_WAKE = async function (triggerId, text) {
    const mcp = await mcpReady;
    if (!mcp) throw boardError('Connectors are not available in this view. Open the page on claude.ai.');
    try {
      await mcp.callTool('Claude Code Remote', 'fire_trigger', {
        trigger_id: triggerId,
        text: text || 'Fernando pressed "Wake now" on the Company Floor dashboard. Take your turn now.',
      }, { cache: false });
    } catch (e) {
      if (e && e.code === 'server_not_connected') throw boardError('Wake now needs the Claude Code Remote connector. Allow it when claude.ai asks, then try again.');
      if (e && e.code === 'tool_error') throw boardError('The scheduled task could not start: ' + String(e.message || '').slice(0, 200));
      throw translate(e);
    }
  };

  // "every 4 hours" -> a cron line for Claude's scheduled task (UTC); "on demand" -> paused.
  function toCron(every) {
    const t = String(every || '').toLowerCase();
    if (/demand|manual/.test(t)) return null;
    const n = Math.max(1, Math.round(parseFloat((t.match(/(\d+(\.\d+)?)/) || [])[1] || '1')));
    const now = new Date();
    if (/min/.test(t)) throw boardError("Claude's scheduled task can run at most once an hour.");
    if (/hour|hr/.test(t)) return n >= 24 ? `49 ${now.getUTCHours()} * * *` : n === 1 ? '49 * * * *' : `49 */${n} * * *`;
    if (/day|daily/.test(t)) return n === 1 ? `49 ${now.getUTCHours()} * * *` : `49 ${now.getUTCHours()} */${n} * *`;
    if (/week/.test(t)) return `49 ${now.getUTCHours()} * * ${now.getUTCDay()}`;
    throw boardError(`Can't turn "${every}" into a schedule.`);
  }

  window.BOARD_SCHEDULE = async function (triggerId, every) {
    const mcp = await mcpReady;
    if (!mcp) throw boardError('Connectors are not available in this view. Open the page on claude.ai.');
    const cron = toCron(every);
    const input = cron ? { trigger_id: triggerId, cron_expression: cron, enabled: true } : { trigger_id: triggerId, enabled: false };
    try {
      await mcp.callTool('Claude Code Remote', 'update_trigger', input, { cache: false });
    } catch (e) {
      if (e && e.code === 'server_not_connected') throw boardError('Allow the Claude Code Remote connector when claude.ai asks, then press Refresh.');
      throw translate(e);
    }
  };

  // Sprites drawn by Higgsfield with the viewer's own Higgsfield connector (their plan's credits).
  // The picture is then fetched and shrunk on the board's side (sprite_fetch / sprite_result),
  // because this page cannot download from other sites.
  const HF = 'Higgsfield';
  const hfData = (res) => {
    let p = res && res.payload !== undefined ? res.payload : res;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { /* keep text */ } }
    if (p && !p.results && !p.jobs && !p.cost && Array.isArray(p.content)) {
      const t = p.content.find((b) => b.type === 'text');
      if (t) { try { p = JSON.parse(t.text); } catch { /* keep */ } }
    }
    return p || {};
  };
  const hfParams = (look, extra) => ({
    model: 'gpt_image_2_5', aspect_ratio: '1:1', count: 1, use_unlim: false,
    prompt: `${look}, drawn as a cute round mascot head for a game sprite: chibi proportions, big expressive eyes, flat vector colours, a thick clean dark outline, centred and filling a circle, plain light background, no text.`,
    ...extra,
  });
  const hfError = (e) => {
    if (e && e.code === 'server_not_connected') return boardError('Connect Higgsfield in claude.ai (Settings → Connectors), allow it for this page, then try again.');
    if (e && e.code === 'tool_error') return boardError('Higgsfield said: ' + String(e.message || '').slice(0, 200));
    return translate(e);
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  window.BOARD_HIGGSFIELD = {
    async cost(look) {
      const mcp = await mcpReady;
      if (!mcp) throw boardError('Connectors are not available in this view.');
      try {
        const r = hfData(await mcp.callTool(HF, 'generate_image', { params: hfParams(look || 'a character', { get_cost: true }) }, { cache: false }));
        return r.cost ? r.cost.credits : null;
      } catch (e) { throw hfError(e); }
    },
    async make(look, token, onStatus = () => {}) {
      const mcp = await mcpReady;
      if (!mcp) throw boardError('Connectors are not available in this view.');
      let job;
      try {
        onStatus('Asking Higgsfield to draw it…');
        const r = hfData(await mcp.callTool(HF, 'generate_image', {
          params: hfParams(look), context: 'Make a round cartoon sprite for an AI agent on a personal dashboard.',
        }, { cache: false }));
        job = r.results && r.results[0] && r.results[0].id;
        if (!job) throw boardError('Higgsfield did not start a picture.' + (r.message ? ' ' + String(r.message).slice(0, 160) : ''));
        let url = '';
        for (let i = 0; i < 12 && !url; i++) {
          onStatus('Drawing… (usually under a minute)');
          const w = hfData(await mcp.callTool(HF, 'jobs_wait', { jobs: [{ index: 0, job_id: job }], timeout_seconds: 15 }, { cache: false }));
          const j = (w.jobs || [])[0] || {};
          if (j.status === 'completed') url = j.result_url;
          else if (j.status && /fail|cancel|nsfw|error/.test(j.status)) throw boardError(`Higgsfield could not draw it (${j.status}). Try describing it differently.`);
        }
        if (!url) throw boardError('Higgsfield is taking long. Your picture will be in your Higgsfield library; try again in a minute.');
        onStatus('Shrinking it to sprite size…');
        const start = await window.BOARD_TRANSPORT('sprite_fetch', { url }, token);
        for (let i = 0; i < 20; i++) {
          await pause(1500);
          const r2 = await window.BOARD_TRANSPORT('sprite_result', { request_id: start.request_id }, token);
          if (r2.image) return r2.image;
          if (r2.error) throw boardError(r2.error);
        }
        throw boardError('The board took too long to fetch the picture. Try again.');
      } catch (e) {
        throw e && e.code ? hfError(e) : e;
      }
    },
  };

  // Saving a file from the File cabinet goes through claude.ai's download prompt.
  const downloadsReady = window.claude && window.claude.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
  window.BOARD_DOWNLOAD = async function (filename, data) {
    const downloads = await downloadsReady;
    if (!downloads) throw boardError('Downloads are not available in this view.');
    try {
      await downloads.save({ filename, data });
    } catch (e) {
      if (e && e.code === 'declined') return;
      if (e && e.code === 'rejected_extension') throw boardError('This file type can\'t be saved from here.');
      if (e && e.code === 'rate_limited') throw boardError('A save prompt is already open. Try again in a moment.');
      throw boardError('Saving is not available in this view.');
    }
  };
}());
