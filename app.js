/* ============================================================
   codetour — client-side guided code walkthroughs.
   Heuristic static parsing (regex/tokenisation). No AI.
   No network. No dependencies. State in localStorage.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- tiny helpers ---------- */
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  var STORE_KEY = "codetour:v1";

  /* ============================================================
     1) FILE SPLITTING  — split on "// file:" / "# file:" markers
     ============================================================ */
  function splitFiles(raw) {
    var lines = raw.split(/\r?\n/);
    var marker = /^\s*(?:\/\/|#|--)\s*file:\s*(.+?)\s*$/i;
    var files = [];
    var cur = null;
    lines.forEach(function (ln) {
      var m = ln.match(marker);
      if (m) {
        cur = { name: m[1].trim(), lines: [] };
        files.push(cur);
      } else {
        if (!cur) { cur = { name: "", lines: [] }; files.push(cur); }
        cur.lines.push(ln);
      }
    });
    if (!files.length) files.push({ name: "", lines: [] });
    return files.map(function (f) {
      // trim leading blank lines so line 1 is meaningful
      while (f.lines.length && /^\s*$/.test(f.lines[0])) f.lines.shift();
      return { name: f.name, code: f.lines.join("\n") };
    }).filter(function (f) { return f.code.trim().length; });
  }

  /* ============================================================
     2) LANGUAGE DETECTION
     ============================================================ */
  function detectLang(name, code) {
    var n = (name || "").toLowerCase();
    if (/\.tsx?$/.test(n)) return "ts";
    if (/\.(jsx?|mjs|cjs)$/.test(n)) return "js";
    if (/\.py$/.test(n)) return "py";
    if (/\.go$/.test(n)) return "go";
    if (n && /\.(md|markdown|txt|rst)$/.test(n)) return "plain";
    // content sniff
    if (/^\s*package\s+\w+/m.test(code) && /\bfunc\b/.test(code)) return "go";
    if (/^\s*(?:async\s+)?def\s+\w+\s*\(/m.test(code) || /^\s*class\s+\w+.*:\s*$/m.test(code)) return "py";
    if (/\b(?:const|let|var|function|export|import)\b/.test(code) || /=>/.test(code)) return "js";
    return "plain";
  }

  function lineOf(code, index) {
    var n = 1;
    for (var i = 0; i < index && i < code.length; i++) {
      if (code.charCodeAt(i) === 10) n++;
    }
    return n;
  }

  /* ============================================================
     3) LANDMARK FINDER  (per language, regex heuristics)
     Each landmark: { kind, name, line, sig }
     ============================================================ */
  function findLandmarks(code, lang) {
    var out = [];
    function push(kind, name, index, sig) {
      out.push({ kind: kind, name: name, line: lineOf(code, index), sig: (sig || "").trim().slice(0, 90) });
    }
    var re, m;

    if (lang === "js" || lang === "ts") {
      re = /^[ \t]*import\s+([^;\n]+?)\s+from\s+['"][^'"]+['"]/gm;
      while ((m = re.exec(code))) push("import", m[1].replace(/[{}]/g, "").trim().slice(0, 50), m.index, m[0]);
      re = /^[ \t]*import\s+['"]([^'"]+)['"]/gm;
      while ((m = re.exec(code))) push("import", m[1], m.index, m[0]);
      re = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;
      while ((m = re.exec(code))) push("function", m[1], m.index, m[0]);
      re = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm;
      while ((m = re.exec(code))) push("function", m[1], m.index, m[0]);
      re = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm;
      while ((m = re.exec(code))) push("class", m[1], m.index, m[0]);
      re = /^[ \t]*(?:export\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm;
      while ((m = re.exec(code))) push("type", m[1], m.index, m[0]);
      re = /^[ \t]*export\s*(?:default\s+)?\{[^}]*\}/gm;
      while ((m = re.exec(code))) push("export", m[0].replace(/\s+/g, " ").trim().slice(0, 50), m.index, m[0]);

    } else if (lang === "py") {
      re = /^[ \t]*(?:from\s+[.\w]+\s+)?import\s+[^\n]+/gm;
      while ((m = re.exec(code))) push("import", m[0].trim().slice(0, 55), m.index, m[0]);
      re = /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm;
      while ((m = re.exec(code))) push(m[1].length > 0 ? "method" : "function", m[2], m.index, m[0]);
      re = /^[ \t]*class\s+([A-Za-z_]\w*)/gm;
      while ((m = re.exec(code))) push("class", m[1], m.index, m[0]);
      re = /^[ \t]*if\s+__name__\s*==\s*['"]__main__['"]/gm;
      while ((m = re.exec(code))) push("entry", "__main__ block", m.index, m[0]);

    } else if (lang === "go") {
      re = /^[ \t]*package\s+(\w+)/gm;
      while ((m = re.exec(code))) push("package", m[1], m.index, m[0]);
      re = /^[ \t]*import\s+(?:\(|"[^"]+")/gm;
      while ((m = re.exec(code))) push("import", m[0].replace(/\s+/g, " ").trim().slice(0, 40), m.index, m[0]);
      re = /^[ \t]*func\s+\(([^)]*)\)\s+([A-Za-z_]\w*)\s*\(/gm;
      while ((m = re.exec(code))) push("method", m[2], m.index, m[0]);
      re = /^[ \t]*func\s+([A-Za-z_]\w*)\s*\(/gm;
      while ((m = re.exec(code))) push("function", m[1], m.index, m[0]);
      re = /^[ \t]*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/gm;
      while ((m = re.exec(code))) push("type", m[1], m.index, m[0]);

    } else {
      // plain: markdown headings, "Label:" lines, or ALL-CAPS section markers
      re = /^[ \t]*(#{1,6}[ \t]+.+|[A-Z][A-Za-z0-9 _\/-]{0,58}:[ \t]*)$/gm;
      while ((m = re.exec(code))) push("section", m[0].replace(/^#+\s*/, "").trim().slice(0, 60), m.index, m[0]);
    }

    // dedupe (line+kind+name), keep first, sort by line
    var seen = {};
    out = out.filter(function (l) {
      var k = l.line + "|" + l.kind + "|" + l.name;
      if (seen[k]) return false; seen[k] = 1; return true;
    });
    out.sort(function (a, b) { return a.line - b.line; });
    return out;
  }

  /* ============================================================
     4) ENTRY-POINT heuristic — for ordering the tour
     ============================================================ */
  function isEntry(l, lang) {
    var n = (l.name || "").toLowerCase();
    if (l.kind === "entry") return true;
    if (lang === "go" && l.kind === "function" && l.name === "main") return true;
    if ((lang === "js" || lang === "ts") && l.kind === "function" &&
        /^(main|init|start|run|app|handler|handle|default|render|mount|bootstrap|setup)$/.test(n)) return true;
    if (lang === "py" && (l.kind === "function") &&
        /^(main|run|app|handler|cli|setup)$/.test(n)) return true;
    return false;
  }

  /* ============================================================
     5) EXCERPT RANGE — brace or indentation body span
     returns [startLine, endLine] 1-based inclusive
     ============================================================ */
  function excerptRange(lines, startLine, lang, maxLines) {
    var start = startLine - 1;
    var end = start;
    maxLines = maxLines || 22;
    if (start < 0 || start >= lines.length) return [startLine, startLine];

    if (lang === "js" || lang === "ts" || lang === "go") {
      var depth = 0, opened = false;
      for (var i = start; i < lines.length; i++) {
        var line = lines[i];
        for (var c = 0; c < line.length; c++) {
          var ch = line[c];
          if (ch === "{") { depth++; opened = true; }
          else if (ch === "}") { depth--; }
        }
        end = i;
        // brace body fully closed — done
        if (opened && depth <= 0) break;
        if (i - start >= maxLines - 1) break;
        // Not yet inside a brace body. If the current line doesn't look like a
        // signature that continues to a "{" (ends with "{", "(", ",", "=", "|",
        // "&", "\\" or ">"), treat this as a braceless statement (import,
        // package, single-line type, one-line arrow) and stop here.
        if (!opened && !/[{(,=|&\\>]\s*$/.test(line)) break;
      }
    } else if (lang === "py") {
      var baseIndent = (lines[start].match(/^[ \t]*/) || [""])[0].length;
      end = start;
      for (var j = start + 1; j < lines.length; j++) {
        var ln = lines[j];
        if (/^\s*$/.test(ln)) { end = j; continue; }
        var ind = (ln.match(/^[ \t]*/) || [""])[0].length;
        if (ind <= baseIndent) break;
        end = j;
        if (j - start >= maxLines - 1) break;
      }
      while (end > start && /^\s*$/.test(lines[end])) end--;
    } else {
      end = Math.min(start + 4, lines.length - 1);
      // stop at next blank line for plain sections
      for (var k = start + 1; k <= end; k++) {
        if (/^\s*$/.test(lines[k])) { end = k - 1; break; }
      }
    }
    return [start + 1, end + 1];
  }

  /* ============================================================
     6) BUILD TOUR — files -> ordered stops
     stop: { id, file, lang, kind, name, line, startLine, endLine, excerpt[], note, entry }
     ============================================================ */
  var _seq = 0;
  function uid() { return "s" + (++_seq) + Math.random().toString(36).slice(2, 6); }

  function buildTour(raw, forcedLang) {
    var files = splitFiles(raw);
    var stops = [];
    var langsSeen = {};

    files.forEach(function (f) {
      var lang = forcedLang && forcedLang !== "auto" ? forcedLang : detectLang(f.name, f.code);
      langsSeen[lang] = true;
      var lines = f.code.split("\n");
      var marks = findLandmarks(f.code, lang);

      marks.forEach(function (l) {
        var range = excerptRange(lines, l.line, lang);
        var body = lines.slice(range[0] - 1, range[1]).map(function (t, i) {
          return { n: range[0] + i, t: t };
        });
        stops.push({
          id: uid(),
          file: f.name || "(pasted code)",
          lang: lang,
          kind: l.kind,
          name: l.name,
          line: l.line,
          startLine: range[0],
          endLine: range[1],
          excerpt: body,
          note: "",
          entry: isEntry(l, lang)
        });
      });
    });

    // ORDER: entry points first (in file order), then everything else in file+line order
    stops.sort(function (a, b) {
      if (a.entry !== b.entry) return a.entry ? -1 : 1;
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return a.line - b.line;
    });

    return { stops: stops, langs: Object.keys(langsSeen) };
  }

  /* ============================================================
     7) TINY SYNTAX TOKENIZER (hand-rolled; no library)
     Highlights a single line into safe HTML spans.
     ============================================================ */
  var KEYWORDS = {
    js: /\b(?:import|from|export|default|const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|super|this|async|await|yield|try|catch|finally|throw|typeof|instanceof|in|of|void|delete|null|undefined|true|false)\b/g,
    ts: /\b(?:import|from|export|default|const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|super|this|async|await|yield|try|catch|finally|throw|typeof|instanceof|in|of|void|delete|null|undefined|true|false|interface|type|enum|implements|readonly|public|private|protected|as|is)\b/g,
    py: /\b(?:import|from|as|def|class|return|if|elif|else|for|while|break|continue|pass|with|try|except|finally|raise|yield|lambda|global|nonlocal|async|await|and|or|not|in|is|None|True|False|self)\b/g,
    go: /\b(?:package|import|func|return|if|else|for|range|switch|case|break|continue|default|type|struct|interface|map|chan|go|defer|select|var|const|nil|true|false)\b/g
  };

  // Tokenize a line -> array of {cls, text}. Order: comments, strings, then keywords/nums on plain runs.
  function tokenizeLine(line, lang) {
    if (lang === "plain" || !KEYWORDS[lang]) return [{ cls: "", text: line }];
    var tokens = [];
    var i = 0, n = line.length;
    var commentStart = (lang === "py") ? "#" : "//";
    while (i < n) {
      var ch = line[i];
      // comment to end of line
      if (line.slice(i, i + commentStart.length) === commentStart) {
        tokens.push({ cls: "tk-com", text: line.slice(i) });
        break;
      }
      // string literal
      if (ch === '"' || ch === "'" || ch === "`") {
        var q = ch, j = i + 1, buf = ch;
        while (j < n) {
          buf += line[j];
          if (line[j] === "\\") { if (j + 1 < n) { buf += line[j + 1]; j += 2; continue; } }
          if (line[j] === q) { j++; break; }
          j++;
        }
        tokens.push({ cls: "tk-str", text: buf });
        i = j;
        continue;
      }
      // plain run until next comment/quote start
      var start = i;
      while (i < n) {
        var c2 = line[i];
        if (c2 === '"' || c2 === "'" || c2 === "`") break;
        if (line.slice(i, i + commentStart.length) === commentStart) break;
        i++;
      }
      tokens.push({ cls: "", text: line.slice(start, i) });
    }
    return tokens;
  }

  // Build safe highlighted HTML for one line.
  // Comment/string runs are escaped and wrapped whole. Plain runs are escaped
  // first (so no raw <,>,&," survive), then keyword/number spans are injected.
  // The regexes only match word/digit runs, never characters inside entities
  // like &amp; or &#39;, so injecting spans into escaped text stays safe.
  function highlightLine(line, lang) {
    var parts = tokenizeLine(line, lang);
    var kw = KEYWORDS[lang];
    return parts.map(function (p) {
      if (p.cls) return '<span class="' + p.cls + '">' + esc(p.text) + "</span>";
      var safe = esc(p.text);
      if (kw) {
        kw.lastIndex = 0;
        safe = safe.replace(kw, function (mm) { return '<span class="tk-key">' + mm + "</span>"; });
      }
      safe = safe.replace(/(^|[^\w&#])(\d[\d_.]*)\b/g, function (whole, pre, num) {
        return pre + '<span class="tk-num">' + num + "</span>";
      });
      return safe;
    }).join("");
  }

  /* ============================================================
     8) STATE
     ============================================================ */
  var state = { title: "", stops: [], langs: [] };
  var storageOk = true;

  function save() {
    if (!storageOk) return;
    try {
      // strip excerpt arrays are fine to keep (small); persist full state
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) { storageOk = false; }
  }
  function load() {
    if (!storageOk) return false;
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var s = JSON.parse(raw);
      if (s && Array.isArray(s.stops)) { state = s; return true; }
    } catch (e) { /* ignore */ }
    return false;
  }

  /* ============================================================
     9) RENDER
     ============================================================ */
  var KIND_LABEL = {
    "function": "function", "method": "method", "class": "class",
    "import": "import", "export": "export", "type": "type",
    "package": "package", "section": "section", "entry": "entry point"
  };
  var LANG_LABEL = { js: "JavaScript", ts: "TypeScript", py: "Python", go: "Go", plain: "Plain text" };

  function render() {
    var tour = $("#tour");
    var empty = $("#empty");
    var toolbar = $("#toolbar");

    if (!state.stops.length) {
      tour.hidden = true;
      empty.hidden = false;
      toolbar.hidden = true;
      return;
    }
    empty.hidden = true;
    toolbar.hidden = false;
    tour.hidden = false;

    // toolbar
    $("#stopCount").textContent = state.stops.length + " " + (state.stops.length === 1 ? "stop" : "stops");
    var langNames = state.langs.map(function (l) { return LANG_LABEL[l] || l; });
    $("#langSummary").textContent = langNames.join(" · ") || "—";
    var titleInput = $("#tourTitle");
    if (titleInput.value !== state.title) titleInput.value = state.title;

    // stops
    tour.innerHTML = "";
    state.stops.forEach(function (stop, idx) {
      tour.appendChild(renderStop(stop, idx));
    });
  }

  function renderStop(stop, idx) {
    var wrap = el("article", "stop" + (stop.entry ? " is-entry" : ""));
    wrap.dataset.id = stop.id;

    // marker
    var marker = el("div", "stop__marker");
    var num = el("div", "stop__num", String(idx + 1));
    num.setAttribute("aria-hidden", "true");
    marker.appendChild(num);
    wrap.appendChild(marker);

    // body
    var body = el("div", "stop__body");

    var head = el("div", "stop__head");
    var kind = el("span", "stop__kind" + (stop.entry ? " k-entry" : ""), stop.entry ? "entry point" : (KIND_LABEL[stop.kind] || stop.kind));
    head.appendChild(kind);
    var name = el("span", "stop__name", stop.name || "(section)");
    head.appendChild(name);
    var loc = el("span", "stop__loc", (stop.file ? stop.file + " · " : "") + "L" + stop.startLine + "–" + stop.endLine);
    head.appendChild(loc);

    // reorder controls
    var reorder = el("span", "stop__reorder");
    var up = el("button", "btn btn--tiny");
    up.type = "button"; up.textContent = "↑"; up.setAttribute("aria-label", "Move stop " + (idx + 1) + " up");
    up.disabled = idx === 0;
    up.addEventListener("click", function () { move(idx, -1); });
    var down = el("button", "btn btn--tiny");
    down.type = "button"; down.textContent = "↓"; down.setAttribute("aria-label", "Move stop " + (idx + 1) + " down");
    down.disabled = idx === state.stops.length - 1;
    down.addEventListener("click", function () { move(idx, 1); });
    var del = el("button", "btn btn--tiny");
    del.type = "button"; del.textContent = "✕"; del.setAttribute("aria-label", "Remove stop " + (idx + 1));
    del.addEventListener("click", function () { removeStop(idx); });
    reorder.appendChild(up); reorder.appendChild(down); reorder.appendChild(del);
    head.appendChild(reorder);
    body.appendChild(head);

    // excerpt
    var ex = el("figure", "excerpt");
    var pre = el("pre");
    var code = el("code");
    code.setAttribute("aria-label", "Code excerpt, lines " + stop.startLine + " to " + stop.endLine);
    var html = stop.excerpt.map(function (row) {
      return '<span class="exline"><span class="exline__n">' + row.n +
        '</span><span class="exline__t">' + highlightLine(row.t, stop.lang) + "</span></span>";
    }).join("");
    code.innerHTML = html;
    pre.appendChild(code);
    ex.appendChild(pre);
    body.appendChild(ex);

    // note
    var noteWrap = el("div", "stop__note");
    var nid = "note-" + stop.id;
    var lab = el("label", null, "Your explanation");
    lab.setAttribute("for", nid);
    noteWrap.appendChild(lab);
    var ta = el("textarea");
    ta.id = nid;
    ta.value = stop.note || "";
    ta.placeholder = "Explain what this " + (KIND_LABEL[stop.kind] || "code") + " does and why a reader should care…";
    ta.addEventListener("input", function () {
      stop.note = ta.value;
      save();
    });
    noteWrap.appendChild(ta);
    body.appendChild(noteWrap);

    wrap.appendChild(body);
    return wrap;
  }

  function move(idx, dir) {
    var j = idx + dir;
    if (j < 0 || j >= state.stops.length) return;
    var tmp = state.stops[idx];
    state.stops[idx] = state.stops[j];
    state.stops[j] = tmp;
    save();
    render();
  }
  function removeStop(idx) {
    state.stops.splice(idx, 1);
    save();
    render();
  }

  /* ============================================================
     10) EXPORT — Markdown + standalone HTML via data URL
     ============================================================ */
  function fmtDate() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function safeSlug(s) {
    return (s || "walkthrough").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "walkthrough";
  }

  function toMarkdown() {
    var title = state.title.trim() || "Code walkthrough";
    var out = ["# " + title, "", "> A guided walkthrough built with codetour — heuristic structure, human notes.", ""];
    state.stops.forEach(function (s, i) {
      out.push("## " + (i + 1) + ". " + (s.name || "(section)") + (s.entry ? "  — entry point" : ""));
      out.push("");
      out.push("`" + (KIND_LABEL[s.kind] || s.kind) + "` · " + (s.file || "(pasted code)") + " · lines " + s.startLine + "–" + s.endLine);
      out.push("");
      var fence = (LANG_LABEL[s.lang] ? { js: "javascript", ts: "typescript", py: "python", go: "go", plain: "" }[s.lang] : "");
      out.push("```" + fence);
      s.excerpt.forEach(function (row) { out.push(row.t); });
      out.push("```");
      out.push("");
      if (s.note && s.note.trim()) { out.push(s.note.trim()); out.push(""); }
    });
    out.push("---");
    out.push("");
    out.push("_Built with codetour. Structure detected heuristically; explanations written by a human. Not a substitute for reading the code._");
    return out.join("\n");
  }

  function toStandaloneHtml() {
    var title = state.title.trim() || "Code walkthrough";
    var css =
      ":root{--bg:#F4EEE1;--card:#FBF7EE;--ink:#1E2A2E;--muted:#4A5A5C;--line:#D8CDB6;" +
      "--teal:#215A57;--ochre:#8A5A12;--codebg:#FBF7EE;--num:#746A50;" +
      "--sans:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
      "--mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace}" +
      "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);" +
      "line-height:1.55;padding:40px 20px}main{max-width:820px;margin:0 auto}" +
      "h1{font-size:2rem;letter-spacing:-.02em;margin:0 0 6px}.sub{color:var(--muted);margin:0 0 32px;font-size:.95rem}" +
      ".stop{position:relative;padding:0 0 26px 60px}.stop::before{content:'';position:absolute;left:22px;top:44px;bottom:0;" +
      "width:2px;background:repeating-linear-gradient(#C7BAA0 0 6px,transparent 6px 14px)}.stop:last-child::before{display:none}" +
      ".num{position:absolute;left:0;top:0;width:46px;height:46px;border-radius:50%;display:grid;place-items:center;" +
      "font-family:var(--mono);font-weight:700;background:var(--card);color:var(--ochre);border:2.4px solid #C98A2B}" +
      ".entry .num{background:#C98A2B;color:#1E2A2E}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}" +
      ".hd{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}" +
      ".kind{font-size:.63rem;font-weight:800;text-transform:uppercase;letter-spacing:.09em;padding:3px 9px;border-radius:999px;" +
      "background:#D9E7E4;color:#1C4E4B}.entry .kind{background:#F0E2C6;color:#6E4A12}.nm{font-family:var(--mono);font-weight:700}" +
      ".loc{margin-left:auto;font-family:var(--mono);font-size:.76rem;color:var(--muted)}" +
      "pre{margin:0;padding:14px 16px;overflow-x:auto;background:var(--codebg);border-bottom:1px solid var(--line)}" +
      "code{font-family:var(--mono);font-size:.84rem;line-height:1.6;white-space:pre}.n{color:var(--num);display:inline-block;width:3em;text-align:right;padding-right:1em;user-select:none}" +
      ".note{padding:14px 16px;color:var(--ink);white-space:pre-wrap}.note:empty{display:none}" +
      "footer{max-width:820px;margin:32px auto 0;color:var(--muted);font-size:.82rem;border-top:1px solid var(--line);padding-top:16px}" +
      "@media(prefers-color-scheme:dark){:root{--bg:#123033;--card:#183C3E;--ink:#E9E3D4;--muted:#9DB0AC;--line:#274B4D;--teal:#7FCCC5;--ochre:#E0A94A;--codebg:#0E282B;--num:#869B97}" +
      ".kind{background:#14322E;color:#7FCCC5}.entry .kind{background:#2A2418;color:#E0A94A}.num{color:#E0A94A;border-color:#E0A94A}.entry .num{background:#E0A94A;color:#123033}}";

    var body = state.stops.map(function (s, i) {
      var lines = s.excerpt.map(function (row) {
        return '<span class="n">' + row.n + "</span>" + esc(row.t);
      }).join("\n");
      var note = s.note && s.note.trim() ? esc(s.note.trim()) : "";
      return '<div class="stop' + (s.entry ? " entry" : "") + '">' +
        '<div class="num">' + (i + 1) + "</div>" +
        '<div class="card">' +
        '<div class="hd"><span class="kind">' + esc(s.entry ? "entry point" : (KIND_LABEL[s.kind] || s.kind)) + "</span>" +
        '<span class="nm">' + esc(s.name || "(section)") + "</span>" +
        '<span class="loc">' + esc((s.file ? s.file + " · " : "") + "L" + s.startLine + "–" + s.endLine) + "</span></div>" +
        "<pre><code>" + lines + "</code></pre>" +
        (note ? '<p class="note">' + note + "</p>" : "") +
        "</div></div>";
    }).join("\n");

    return "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>" + esc(title) + "</title><style>" + css + "</style></head><body><main>" +
      "<h1>" + esc(title) + "</h1>" +
      "<p class=\"sub\">A guided walkthrough &middot; " + state.stops.length + " stops &middot; built with codetour</p>" +
      body +
      "</main><footer>Built with codetour. Structure was detected heuristically (no AI); the explanations were written by a human. " +
      "This document is a reading aid, not a substitute for the source.</footer></body></html>";
  }

  function download(filename, text, mime) {
    var uri = "data:" + mime + ";charset=utf-8," + encodeURIComponent(text);
    var a = document.createElement("a");
    a.setAttribute("href", uri);
    a.setAttribute("download", filename);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /* ============================================================
     11) SAMPLE
     ============================================================ */
  var SAMPLE = [
    "// file: src/app.js",
    "import { createStore } from './store.js';",
    "import { render } from './render.js';",
    "",
    "// The single entry point: wire the store to the DOM and paint once.",
    "export function main() {",
    "  const store = createStore({ count: 0 });",
    "  store.subscribe(() => render(store.state));",
    "  render(store.state);",
    "  return store;",
    "}",
    "",
    "export const increment = (store) => {",
    "  store.set({ count: store.state.count + 1 });",
    "};",
    "",
    "# file: server/handler.py",
    "from http.server import BaseHTTPRequestHandler",
    "",
    "class Handler(BaseHTTPRequestHandler):",
    "    def do_GET(self):",
    "        self.send_response(200)",
    "        self.end_headers()",
    "        self.wfile.write(b'ok')",
    "",
    "def run(port=8080):",
    "    server = HTTPServer(('', port), Handler)",
    "    server.serve_forever()",
    "",
    'if __name__ == "__main__":',
    "    run()",
    "",
    "// file: cmd/main.go",
    "package main",
    "",
    'import "fmt"',
    "",
    "type Greeter struct {",
    "    name string",
    "}",
    "",
    "func (g *Greeter) Hello() string {",
    '    return "hi, " + g.name',
    "}",
    "",
    "func main() {",
    "    g := &Greeter{name: \"world\"}",
    "    fmt.Println(g.Hello())",
    "}"
  ].join("\n");

  /* ============================================================
     12) WIRE UP
     ============================================================ */
  function doBuild() {
    var raw = $("#codeInput").value;
    if (!raw.trim()) {
      $("#inputNote").textContent = "Paste some code first — then build.";
      return;
    }
    var forced = $("#langSelect").value;
    var built = buildTour(raw, forced);
    if (!built.stops.length) {
      $("#inputNote").textContent = "No landmarks found — try Plain text, or check the language.";
    } else {
      $("#inputNote").textContent = "Everything stays on this device.";
    }
    // preserve title, replace stops
    state.stops = built.stops;
    state.langs = built.langs;
    save();
    render();
    var tb = $("#toolbar");
    if (tb && !tb.hidden && tb.scrollIntoView) tb.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function init() {
    try { localStorage.setItem("codetour:test", "1"); localStorage.removeItem("codetour:test"); }
    catch (e) { storageOk = false; }

    load();

    $("#buildBtn").addEventListener("click", doBuild);

    $("#sampleBtn").addEventListener("click", function () {
      $("#codeInput").value = SAMPLE;
      $("#langSelect").value = "auto";
      doBuild();
    });

    $("#clearBtn").addEventListener("click", function () {
      $("#codeInput").value = "";
      state = { title: "", stops: [], langs: [] };
      save();
      render();
      $("#inputNote").textContent = "Everything stays on this device.";
    });

    $("#tourTitle").addEventListener("input", function () {
      state.title = this.value;
      save();
    });

    $("#exportMdBtn").addEventListener("click", function () {
      if (!state.stops.length) return;
      download(safeSlug(state.title) + "-" + fmtDate() + ".md", toMarkdown(), "text/markdown");
    });
    $("#exportHtmlBtn").addEventListener("click", function () {
      if (!state.stops.length) return;
      download(safeSlug(state.title) + "-" + fmtDate() + ".html", toStandaloneHtml(), "text/html");
    });

    renderRoute();
    render();
  }

  /* ============================================================
     13) HERO ROUTE SIGNATURE — a winding path with waypoints
     ============================================================ */
  function renderRoute() {
    var pathEl = $(".route__line");
    var stopsG = $(".route__stops");
    if (!pathEl || !stopsG) return;

    var W = 1440, midY = 150;
    var pts = [];
    var count = 7;
    for (var i = 0; i <= count; i++) {
      var x = (W / count) * i;
      var y = midY + Math.sin(i * 0.9) * 60 + Math.sin(i * 2.1) * 22;
      pts.push([x, y]);
    }
    // smooth path
    var d = "M " + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
    for (var j = 1; j < pts.length; j++) {
      var px = (pts[j - 1][0] + pts[j][0]) / 2;
      d += " Q " + pts[j - 1][0].toFixed(1) + " " + pts[j - 1][1].toFixed(1) +
        " " + px.toFixed(1) + " " + ((pts[j - 1][1] + pts[j][1]) / 2).toFixed(1);
      d += " T " + pts[j][0].toFixed(1) + " " + pts[j][1].toFixed(1);
    }
    pathEl.setAttribute("d", d);

    var frag = document.createDocumentFragment();
    for (var k = 1; k < pts.length - 1; k++) {
      var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      var circ = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circ.setAttribute("cx", pts[k][0].toFixed(1));
      circ.setAttribute("cy", pts[k][1].toFixed(1));
      circ.setAttribute("r", "14");
      if (k % 2 === 0) circ.setAttribute("class", "is-fill");
      var txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
      txt.setAttribute("x", pts[k][0].toFixed(1));
      txt.setAttribute("y", (pts[k][1] + 0.5).toFixed(1));
      txt.textContent = String(k);
      g.appendChild(circ); g.appendChild(txt);
      frag.appendChild(g);
    }
    stopsG.appendChild(frag);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
