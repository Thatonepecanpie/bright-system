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
    const query = `select public.board_owner(${lit(token)}, ${lit(action)}, ${lit(JSON.stringify(args || {}))}::jsonb, 'dashboard (claude.ai)') as r`;
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
  window.BOARD_WAKE = async function (triggerId) {
    const mcp = await mcpReady;
    if (!mcp) throw boardError('Connectors are not available in this view. Open the page on claude.ai.');
    try {
      await mcp.callTool('Claude Code Remote', 'fire_trigger', {
        trigger_id: triggerId,
        text: 'Fernando pressed "Wake now" on the Company Floor dashboard. Take your turn now.',
      }, { cache: false });
    } catch (e) {
      if (e && e.code === 'server_not_connected') throw boardError('Wake now needs the Claude Code Remote connector. Allow it when claude.ai asks, then try again.');
      if (e && e.code === 'tool_error') throw boardError('The scheduled task could not start: ' + String(e.message || '').slice(0, 200));
      throw translate(e);
    }
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
