/* 매매일지 — 배당앱과 분리된 별도 앱. Supabase 테이블 tj_trades 사용. */
(function () {
  "use strict";

  var SB = (window.supabase && window.SUPABASE_URL && window.SUPABASE_ANON_KEY)
    ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
    : null;

  // ---------- helpers ----------
  var fmt = function (n) { return Math.round(n || 0).toLocaleString("ko-KR"); };
  var num = function (v) {
    var n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
    return isNaN(n) ? 0 : n;
  };
  var uid = function () { return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  };
  var p2 = function (x) { x = String(parseInt(x, 10)); return x.length < 2 ? "0" + x : x; };
  var thisMonth = function () { return new Date().toISOString().slice(0, 7); };

  function normDate(s) {
    s = String(s).trim();
    var m;
    if ((m = s.match(/^(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})$/))) return m[1] + "-" + p2(m[2]) + "-" + p2(m[3]);
    if ((m = s.match(/^(\d{2})[.\/](\d{1,2})[.\/](\d{1,2})$/))) return "20" + m[1] + "-" + p2(m[2]) + "-" + p2(m[3]);
    if ((m = s.match(/^(\d{1,2})[.\/](\d{1,2})$/))) return String(new Date().getFullYear()) + "-" + p2(m[1]) + "-" + p2(m[2]);
    return s;
  }
  function normSide(s) {
    s = String(s).trim();
    if (/매수|구매|매입|buy/i.test(s)) return "매수";
    if (/매도|판매|매각|sell/i.test(s)) return "매도";
    return s;
  }

  // 붙여넣기 파서: 한 줄 = 날짜 | 종목 | 구분 | 수량 | 단가 [| 수수료 | 메모]
  function parseBulk(text) {
    var out = [];
    String(text || "").split(/\r?\n/).forEach(function (line) {
      var raw = line.trim();
      if (!raw) return;
      var parts = raw.indexOf("|") >= 0 ? raw.split("|") : raw.split("\t");
      parts = parts.map(function (x) { return x.trim(); });
      if (parts.length < 5) { out.push({ raw: raw, error: "열 부족(최소 5칸)" }); return; }
      var d = parts[0], name = parts[1], side = parts[2], qty = parts[3], price = parts[4];
      var fee = parts[5], memo = parts[6];
      if (/날짜/.test(d) && /종목/.test(name)) return; // 헤더 줄 건너뜀
      var nd = normDate(d), ns = normSide(side), q = num(qty), pr = num(price), fe = num(fee || 0);
      var err = [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nd)) err.push("날짜");
      if (!name) err.push("종목");
      if (ns !== "매수" && ns !== "매도") err.push("구분");
      if (q <= 0) err.push("수량");
      if (pr <= 0) err.push("단가");
      out.push({
        raw: raw, date: nd, name: name, side: ns, qty: q, price: pr,
        amount: q * pr, fee: fe, memo: memo || "",
        error: err.length ? err.join("·") + " 확인" : null
      });
    });
    return out;
  }

  // ---------- state ----------
  var state = { trades: [], month: thisMonth(), side: "전체", loaded: false, err: "" };
  var preview = [];

  function months() {
    var s = {};
    state.trades.forEach(function (t) { var k = (t.date || "").slice(0, 7); if (k) s[k] = 1; });
    var arr = Object.keys(s).sort();
    if (arr.indexOf(state.month) < 0 && state.month !== "all") arr.push(state.month);
    return arr.sort();
  }
  function filtered() {
    return state.trades.filter(function (t) {
      if (state.month !== "all" && (t.date || "").slice(0, 7) !== state.month) return false;
      if (state.side !== "전체" && t.side !== state.side) return false;
      return true;
    }).sort(function (a, b) {
      if ((a.date || "") !== (b.date || "")) return (a.date || "") < (b.date || "") ? 1 : -1;
      return (a.id || "") < (b.id || "") ? 1 : -1;
    });
  }

  // ---------- data ----------
  function toast(msg) {
    var t = document.getElementById("toast");
    if (t) t.remove();
    t = document.createElement("div");
    t.id = "toast"; t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t) t.remove(); }, 1800);
  }

  async function load() {
    if (!SB) { state.err = "연결 설정이 필요해요 — config.js를 확인해 주세요."; state.loaded = true; render(); return; }
    try {
      var all = [], from = 0;
      while (true) {
        var res = await SB.from("tj_trades").select("*").order("date", { ascending: false }).range(from, from + 999);
        if (res.error) throw res.error;
        all = all.concat(res.data || []);
        if (!res.data || res.data.length < 1000) break;
        from += 1000;
      }
      state.trades = all; state.err = ""; state.loaded = true;
      render();
    } catch (e) {
      state.err = "불러오지 못했어요. tj_trades 테이블(SQL)을 실행했는지, config.js가 맞는지 확인해 주세요.";
      state.loaded = true; render();
    }
  }

  async function insertRows(rows) {
    if (!SB) { toast("연결 안 됨"); return; }
    var payload = rows.map(function (r) {
      return { id: uid(), date: r.date, name: r.name, side: r.side, qty: r.qty, price: r.price, amount: r.amount, fee: r.fee || 0, memo: r.memo || null };
    });
    var res = await SB.from("tj_trades").insert(payload);
    if (res.error) { toast("저장 실패: " + (res.error.message || "확인 필요")); return; }
    state.trades = payload.concat(state.trades);
    toast(rows.length + "건 추가");
    render();
  }

  async function delTrade(id) {
    if (!SB) return;
    state.trades = state.trades.filter(function (t) { return t.id !== id; });
    render();
    var res = await SB.from("tj_trades").delete().eq("id", id);
    if (res.error) toast("삭제 실패");
  }

  async function updateMemo(id, memo) {
    var t = state.trades.find(function (x) { return x.id === id; });
    if (!t) return;
    if ((t.memo || "") === memo) return;
    t.memo = memo;
    var res = await SB.from("tj_trades").update({ memo: memo || null }).eq("id", id);
    toast(res && res.error ? "메모 저장 실패" : "메모 저장");
  }

  // ---------- render ----------
  function kpiBlock() {
    var f = filtered();
    var buyAmt = 0, sellAmt = 0, fee = 0;
    f.forEach(function (t) {
      var a = num(t.amount) || num(t.qty) * num(t.price);
      if (t.side === "매수") buyAmt += a; else if (t.side === "매도") sellAmt += a;
      fee += num(t.fee);
    });
    var net = sellAmt - buyAmt;
    return '<div class="kpis">' +
      kpi("매수 금액", fmt(buyAmt) + " 원", "") +
      kpi("매도 금액", fmt(sellAmt) + " 원", "") +
      kpi("순매매(매도-매수)", (net >= 0 ? "+" : "") + fmt(net), net >= 0 ? "sell" : "buy") +
      kpi("거래 건수", f.length + " 건", "") +
      "</div>" +
      (fee > 0 ? '<div class="sub" style="margin-top:8px">수수료·세금 합계 ' + fmt(fee) + "원</div>" : "");
  }
  function kpi(lab, val, cls) {
    return '<div class="kpi"><div class="lab">' + esc(lab) + '</div><div class="val ' + cls + '">' + val + "</div></div>";
  }

  function listBlock() {
    var f = filtered();
    if (f.length === 0) return '<div class="empty">이 조건에 거래가 없어요. 위에서 붙여넣기로 한 번에 추가해 보세요.</div>';
    var rows = f.map(function (t) {
      var a = num(t.amount) || num(t.qty) * num(t.price);
      var isBuy = t.side === "매수";
      return "<tr>" +
        "<td>" + esc(t.date) + "</td>" +
        '<td style="text-align:left;font-weight:700">' + esc(t.name) + "</td>" +
        '<td><span class="pill ' + (isBuy ? "b" : "s") + '">' + esc(t.side) + "</span></td>" +
        "<td>" + fmt(t.qty) + "</td>" +
        "<td>" + fmt(t.price) + "</td>" +
        '<td class="' + (isBuy ? "buy" : "sell") + '">' + fmt(a) + "</td>" +
        "<td>" + (num(t.fee) ? fmt(t.fee) : "-") + "</td>" +
        '<td style="text-align:left"><input class="icell" data-memo="' + esc(t.id) + '" value="' + esc(t.memo || "") + '" placeholder="메모"></td>' +
        '<td><button class="del" data-del="' + esc(t.id) + '">🗑</button></td>' +
        "</tr>";
    }).join("");
    return '<div class="scroll"><table class="tbl"><thead><tr>' +
      "<th>거래일</th><th>종목</th><th>구분</th><th>수량</th><th>단가</th><th>금액</th><th>수수료</th><th>메모</th><th></th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>";
  }

  function aggBlock() {
    var f = filtered();
    if (f.length === 0) return "";
    var g = {};
    f.forEach(function (t) {
      var k = t.name || "(종목없음)";
      if (!g[k]) g[k] = { bq: 0, ba: 0, sq: 0, sa: 0 };
      var a = num(t.amount) || num(t.qty) * num(t.price);
      if (t.side === "매수") { g[k].bq += num(t.qty); g[k].ba += a; }
      else if (t.side === "매도") { g[k].sq += num(t.qty); g[k].sa += a; }
    });
    var keys = Object.keys(g).sort(function (x, y) { return (g[y].ba + g[y].sa) - (g[x].ba + g[x].sa); });
    var rows = keys.map(function (k) {
      var v = g[k];
      var bavg = v.bq ? v.ba / v.bq : 0, savg = v.sq ? v.sa / v.sq : 0;
      var netQ = v.bq - v.sq;
      return "<tr>" +
        '<td style="text-align:left;font-weight:700">' + esc(k) + "</td>" +
        '<td class="buy">' + fmt(v.bq) + "</td>" +
        "<td>" + (bavg ? fmt(bavg) : "-") + "</td>" +
        '<td class="sell">' + fmt(v.sq) + "</td>" +
        "<td>" + (savg ? fmt(savg) : "-") + "</td>" +
        "<td>" + fmt(netQ) + "</td>" +
        "</tr>";
    }).join("");
    return '<div class="card"><h2>종목별 집계</h2><p class="hint">분할매수·분할매도를 종목별로 합산 — 평균 단가와 순수량으로 복기하기 좋아요.</p>' +
      '<div class="scroll"><table class="tbl" style="min-width:480px"><thead><tr>' +
      "<th>종목</th><th>매수수량</th><th>평매수가</th><th>매도수량</th><th>평매도가</th><th>순수량</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
  }

  function previewBlock() {
    if (preview.length === 0) return "";
    var ok = preview.filter(function (r) { return !r.error; }).length;
    var bad = preview.length - ok;
    var rows = preview.map(function (r) {
      if (r.error) return '<tr><td colspan="6" style="text-align:left" class="err">⚠ ' + esc(r.error) + " — " + esc(r.raw) + "</td></tr>";
      return "<tr>" +
        "<td style='text-align:left'>" + esc(r.date) + "</td>" +
        "<td style='text-align:left;font-weight:700'>" + esc(r.name) + "</td>" +
        '<td><span class="pill ' + (r.side === "매수" ? "b" : "s") + '">' + esc(r.side) + "</span></td>" +
        "<td>" + fmt(r.qty) + "</td>" +
        "<td>" + fmt(r.price) + "</td>" +
        "<td>" + fmt(r.amount) + "</td>" +
        "</tr>";
    }).join("");
    return '<div style="margin-top:10px">' +
      '<div class="sub" style="margin-bottom:6px">미리보기 · 추가 가능 <b class="gold">' + ok + "</b>건" + (bad ? ' · 오류 <b class="err">' + bad + "</b>건(제외됨)" : "") + "</div>" +
      '<div class="scroll"><table class="tbl" style="min-width:460px"><thead><tr><th>날짜</th><th>종목</th><th>구분</th><th>수량</th><th>단가</th><th>금액</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      (ok > 0 ? '<button class="btn pri" id="btnAdd" style="margin-top:10px">' + ok + "건 추가하기</button>" : "") +
      "</div>";
  }

  function render() {
    if (!state.loaded) { document.getElementById("dyn").innerHTML = '<div class="empty">불러오는 중…</div>'; return; }
    var ms = months();
    var monthLabel = state.month === "all" ? "전체" : state.month.replace("-", ".");
    var html =
      (state.err ? '<div class="warn">' + esc(state.err) + "</div>" : "") +
      '<div class="card"><div class="row" style="justify-content:space-between">' +
        '<div class="navm"><button data-mv="-1">‹</button><span class="m" id="mlabel">' + monthLabel + '</span><button data-mv="1">›</button></div>' +
        '<div class="seg" id="segside">' +
          ["전체", "매수", "매도"].map(function (s) { return '<button class="' + (state.side === s ? "on" : "") + '" data-side="' + s + '">' + s + "</button>"; }).join("") +
        "</div>" +
        '<button class="btn gho" data-mv="all" style="padding:8px 12px">전체기간</button>' +
      "</div></div>" +
      '<div class="card">' + kpiBlock() + "</div>" +
      aggBlock() +
      '<div class="card"><h2>거래 내역 <span class="sub">(' + filtered().length + '건)</span></h2>' + listBlock() + "</div>";
    document.getElementById("dyn").innerHTML = html;
    var pv = document.getElementById("previewArea");
    if (pv) pv.innerHTML = previewBlock();
  }

  // ---------- shell + events ----------
  function init() {
    var root = document.getElementById("root");
    root.innerHTML =
      '<div class="tj"><div class="wrap">' +
      '<div class="head"><div class="logo">J</div><div><div class="title">매매일지</div><div class="sub">단타·체결 기록 · 붙여넣기로 한 번에 추가</div></div></div>' +
      // bulk paste card
      '<div class="card"><h2>붙여넣기 일괄추가</h2>' +
      '<p class="hint">한 줄에 하나씩, 이 순서로: <code class="fmt">날짜 | 종목 | 구분 | 수량 | 단가</code> (수수료·메모는 선택). 구분은 매수/매도(구매·판매도 인식). 캡쳐를 채팅에 주면 이 형식으로 변환해 드려요.</p>' +
      '<textarea class="ta" id="bulk" placeholder="예)&#10;2026-08-13 | KODEX 반도체레버리지 | 매도 | 47 | 73200&#10;2026-08-13 | KODEX 반도체레버리지 | 매도 | 15 | 73305&#10;2026-08-11 | 셀트리온 | 매도 | 23 | 209500"></textarea>' +
      '<div class="row" style="margin-top:9px"><button class="btn gho" id="btnPreview">미리보기</button><button class="btn gho" id="btnClear">지우기</button></div>' +
      '<div id="previewArea"></div>' +
      "</div>" +
      // manual add card
      '<div class="card"><h2>직접 추가</h2>' +
      '<div class="grid3" style="margin-bottom:9px">' +
        '<div><label class="lb">거래일</label><input type="date" class="field" id="f_date"></div>' +
        '<div><label class="lb">구분</label><select class="field" id="f_side"><option>매수</option><option>매도</option></select></div>' +
        '<div><label class="lb">종목</label><input class="field" id="f_name" placeholder="종목명"></div>' +
      "</div>" +
      '<div class="grid3" style="margin-bottom:9px">' +
        '<div><label class="lb">수량</label><input class="field" id="f_qty" inputmode="numeric"></div>' +
        '<div><label class="lb">단가(원)</label><input class="field" id="f_price" inputmode="numeric"></div>' +
        '<div><label class="lb">수수료(선택)</label><input class="field" id="f_fee" inputmode="numeric"></div>' +
      "</div>" +
      '<div style="margin-bottom:11px"><label class="lb">메모</label><input class="field" id="f_memo" placeholder="선택"></div>' +
      '<button class="btn pri" id="btnOne">추가하기</button>' +
      "</div>" +
      // dynamic (month nav, kpis, agg, list)
      '<div id="dyn"></div>' +
      "</div></div>";

    var dt = document.getElementById("f_date");
    if (dt) dt.value = new Date().toISOString().slice(0, 10);

    document.getElementById("btnPreview").addEventListener("click", function () {
      preview = parseBulk(document.getElementById("bulk").value);
      var pv = document.getElementById("previewArea");
      if (pv) pv.innerHTML = previewBlock();
      if (preview.length === 0) toast("붙여넣은 내용이 없어요");
    });
    document.getElementById("btnClear").addEventListener("click", function () {
      document.getElementById("bulk").value = ""; preview = [];
      var pv = document.getElementById("previewArea"); if (pv) pv.innerHTML = "";
    });
    document.getElementById("btnOne").addEventListener("click", function () {
      var name = document.getElementById("f_name").value.trim();
      var q = num(document.getElementById("f_qty").value), pr = num(document.getElementById("f_price").value);
      if (!name || q <= 0 || pr <= 0) { toast("종목·수량·단가를 확인하세요"); return; }
      insertRows([{
        date: document.getElementById("f_date").value || new Date().toISOString().slice(0, 10),
        name: name, side: document.getElementById("f_side").value,
        qty: q, price: pr, amount: q * pr,
        fee: num(document.getElementById("f_fee").value), memo: document.getElementById("f_memo").value.trim()
      }]);
      document.getElementById("f_name").value = ""; document.getElementById("f_qty").value = "";
      document.getElementById("f_price").value = ""; document.getElementById("f_fee").value = ""; document.getElementById("f_memo").value = "";
    });

    // delegated events on dynamic area
    document.getElementById("dyn").addEventListener("click", function (e) {
      var mv = e.target.getAttribute("data-mv");
      if (mv) {
        if (mv === "all") { state.month = "all"; }
        else {
          var ms = months().filter(function (x) { return x !== "all"; });
          if (state.month === "all") state.month = ms[ms.length - 1] || thisMonth();
          else state.month = shiftMonth(state.month, parseInt(mv, 10));
        }
        render(); return;
      }
      var sd = e.target.getAttribute("data-side");
      if (sd) { state.side = sd; render(); return; }
      var del = e.target.getAttribute("data-del");
      if (del) { if (confirm("이 거래를 삭제할까요?")) delTrade(del); return; }
    });
    document.getElementById("dyn").addEventListener("blur", function (e) {
      var id = e.target.getAttribute && e.target.getAttribute("data-memo");
      if (id) updateMemo(id, e.target.value.trim());
    }, true);

    // delegated add button inside preview
    document.getElementById("previewArea").addEventListener("click", function (e) {
      if (e.target && e.target.id === "btnAdd") {
        var good = preview.filter(function (r) { return !r.error; });
        if (good.length === 0) return;
        insertRows(good);
        preview = []; document.getElementById("bulk").value = "";
        e.currentTarget.innerHTML = "";
      }
    });

    load();
  }

  function shiftMonth(m, d) {
    var y = parseInt(m.slice(0, 4), 10), mo = parseInt(m.slice(5, 7), 10) - 1 + d;
    var dt = new Date(y, mo, 1);
    return dt.getFullYear() + "-" + p2(dt.getMonth() + 1);
  }

  // expose parser for quick testing in console
  window.__parseBulk = parseBulk;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
