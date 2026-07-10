/**
 * clerk.io embeddable widget — floating bubble + chat panel.
 * Install:
 *   <script src="https://YOUR-HOST/widget/v1.js" data-clerk-key="pk_live_…" async></script>
 */
(function () {
  "use strict";
  if (window.__CLERK_IO_WIDGET__) return;
  window.__CLERK_IO_WIDGET__ = true;

  var script = document.currentScript || (function () {
    var list = document.getElementsByTagName("script");
    return list[list.length - 1];
  })();

  var KEY = (script && script.getAttribute("data-clerk-key")) || "";
  var BASE = (script && script.getAttribute("data-clerk-base")) ||
    (script && script.src ? script.src.replace(/\/widget\/v1\.js.*$/i, "") : "");
  if (!KEY || !BASE) {
    console.warn("[clerk.io] missing data-clerk-key or data-clerk-base");
    return;
  }

  var state = {
    open: false,
    sessionToken: null,
    config: null,
    sending: false,
    messages: [],
  };

  var VISITOR_KEY = "clerk_io_vid";
  function visitorId() {
    try {
      var v = localStorage.getItem(VISITOR_KEY);
      if (v) return v;
      v = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(VISITOR_KEY, v);
      return v;
    } catch (e) {
      return "v_anon";
    }
  }

  function api(path, body) {
    return fetch(BASE + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Clerk-Origin": location.origin,
      },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  // ---------- styles ----------
  var css = document.createElement("style");
  css.textContent = [
    "#clerk-io-root{all:initial;font-family:Inter,system-ui,-apple-system,sans-serif;position:fixed;z-index:2147483000;right:20px;bottom:20px;color:#E8ECFF}",
    "#clerk-io-root *{box-sizing:border-box;font-family:inherit}",
    "#clerk-io-bubble{width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;display:grid;place-items:center;",
    "background:conic-gradient(from 0deg,#22F3EE,#A78BFA,#FF3DA6,#22F3EE);box-shadow:0 8px 32px rgba(34,243,238,.35);position:relative}",
    "#clerk-io-bubble::after{content:'';position:absolute;inset:4px;border-radius:50%;background:#05060E}",
    "#clerk-io-bubble span{position:relative;z-index:1;font-size:11px;font-weight:700;letter-spacing:.04em;color:#22F3EE}",
    "#clerk-io-panel{display:none;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 100px));",
    "flex-direction:column;background:rgba(9,11,24,.96);border:1px solid rgba(124,134,173,.25);border-radius:18px;",
    "box-shadow:0 20px 60px rgba(0,0,0,.55);overflow:hidden;margin-bottom:14px;backdrop-filter:blur(16px)}",
    "#clerk-io-root.open #clerk-io-panel{display:flex}",
    "#clerk-io-head{padding:14px 16px;display:flex;align-items:center;justify-content:space-between;",
    "border-bottom:1px solid rgba(124,134,173,.2);background:rgba(15,19,36,.9)}",
    "#clerk-io-head b{font-size:14px;color:#E8ECFF}",
    "#clerk-io-head small{display:block;font-size:10px;color:#8B94BC;margin-top:2px;letter-spacing:.08em;text-transform:uppercase}",
    "#clerk-io-close{background:none;border:none;color:#8B94BC;font-size:20px;cursor:pointer;line-height:1}",
    "#clerk-io-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}",
    ".cio-msg{max-width:88%;padding:10px 12px;border-radius:14px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word}",
    ".cio-msg.customer{align-self:flex-end;background:rgba(34,243,238,.14);border:1px solid rgba(34,243,238,.28);color:#E8ECFF}",
    ".cio-msg.clerk{align-self:flex-start;background:rgba(22,27,50,.9);border:1px solid rgba(124,134,173,.22);color:#E8ECFF}",
    ".cio-msg.sys{align-self:center;font-size:11px;color:#8B94BC;background:transparent;border:none;padding:4px}",
    "#clerk-io-form{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(124,134,173,.2)}",
    "#clerk-io-input{flex:1;border-radius:12px;border:1px solid rgba(124,134,173,.28);background:#0c0f1c;color:#E8ECFF;",
    "padding:10px 12px;font-size:13.5px;outline:none}",
    "#clerk-io-input:focus{border-color:#22F3EE}",
    "#clerk-io-send{border:none;border-radius:12px;padding:0 14px;font-weight:700;font-size:13px;cursor:pointer;",
    "background:linear-gradient(120deg,#22F3EE,#14c8c4);color:#032120}",
    "#clerk-io-send:disabled{opacity:.4;cursor:not-allowed}",
    "#clerk-io-badge{position:absolute;top:-4px;right:-4px;width:14px;height:14px;border-radius:50%;",
    "background:#22F3EE;box-shadow:0 0 10px #22F3EE;display:none}",
    "@media(prefers-reduced-motion:reduce){#clerk-io-bubble{animation:none}}",
  ].join("");
  document.head.appendChild(css);

  // ---------- DOM ----------
  var root = el("div");
  root.id = "clerk-io-root";
  root.setAttribute("aria-live", "polite");

  var panel = el("div");
  panel.id = "clerk-io-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "clerk.io support chat");

  var head = el("div");
  head.id = "clerk-io-head";
  head.innerHTML = "<div><b id='clerk-io-title'>clerk.io</b><small id='clerk-io-mode'>support</small></div>";
  var closeBtn = el("button");
  closeBtn.id = "clerk-io-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close chat");
  closeBtn.textContent = "×";
  head.appendChild(closeBtn);

  var msgs = el("div");
  msgs.id = "clerk-io-msgs";

  var form = el("form");
  form.id = "clerk-io-form";
  var input = el("input");
  input.id = "clerk-io-input";
  input.type = "text";
  input.placeholder = "Type your message…";
  input.autocomplete = "off";
  var send = el("button");
  send.id = "clerk-io-send";
  send.type = "submit";
  send.textContent = "Send";
  form.appendChild(input);
  form.appendChild(send);

  panel.appendChild(head);
  panel.appendChild(msgs);
  panel.appendChild(form);

  var bubble = el("button");
  bubble.id = "clerk-io-bubble";
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Open clerk.io support");
  bubble.innerHTML = "<span>clerk</span><i id='clerk-io-badge'></i>";

  root.appendChild(panel);
  root.appendChild(bubble);
  document.body.appendChild(root);

  function addMsg(role, body) {
    state.messages.push({ role: role, body: body });
    var m = el("div", "cio-msg " + role);
    m.textContent = body;
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function setOpen(v) {
    state.open = v;
    root.classList.toggle("open", v);
    if (v) {
      input.focus();
      ensureSession();
    }
  }

  bubble.addEventListener("click", function () { setOpen(!state.open); });
  closeBtn.addEventListener("click", function () { setOpen(false); });

  function ensureSession() {
    if (state.sessionToken) return Promise.resolve();
    return api("/api/widget/session", {
      publicKey: KEY,
      visitorId: visitorId(),
      pageUrl: location.href,
    }).then(function (out) {
      state.sessionToken = out.sessionToken;
      state.config = out.config || {};
      var title = document.getElementById("clerk-io-title");
      var mode = document.getElementById("clerk-io-mode");
      if (title) title.textContent = state.config.title || "clerk.io support";
      if (mode) mode.textContent = (state.config.mode === "live" ? "live" : "standby · learning") + " · clerk.io";
      if (state.config.accent) {
        bubble.style.boxShadow = "0 8px 32px " + state.config.accent + "55";
      }
      if (!state.messages.length) {
        addMsg("clerk", state.config.greeting || "Hi — how can we help?");
      }
    }).catch(function (e) {
      addMsg("sys", "Could not start chat: " + e.message);
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (state.sending) return;
    var text = (input.value || "").trim();
    if (!text) return;
    input.value = "";
    addMsg("customer", text);
    state.sending = true;
    send.disabled = true;

    ensureSession()
      .then(function () {
        return api("/api/widget/message", {
          publicKey: KEY,
          sessionToken: state.sessionToken,
          message: text,
        });
      })
      .then(function (out) {
        if (out.reply) addMsg("clerk", out.reply);
        else if (out.messages && out.messages[0]) addMsg("clerk", out.messages[0].body);
      })
      .catch(function (err) {
        addMsg("sys", "Error: " + err.message);
      })
      .then(function () {
        state.sending = false;
        send.disabled = false;
        input.focus();
      });
  });
})();
