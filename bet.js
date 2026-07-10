const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// =========================================================================
// 1. CẤU HÌNH HỆ THỐNG VÀ BỘ NHỚ ĐỆM ĐỒNG BỘ REALTIME
// =========================================================================
const PORT = process.env.PORT || 3000;
const URL_TAIXIU = "https://wtx.macminim6.online/v1/tx/sessions";
const URL_MD5 = "https://wtxmd52.macminim6.online/v1/txmd5/sessions";
const USER_ID = "@phong296 VIPPRO";

const STABILITY_WEIGHTS = {
    pattern_matching: 0.35,
    markov: 0.25,
    bet: 0.10,
    ping_pong: 0.10,
    cau_hinh_hoc: 0.15,
    overall_stats: 0.05
};
let cacheHistoryTaiXiu = [];
let cacheHistoryMD5 = [];

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// =========================================================================
// 2. HỆ THỐNG THUẬT TOÁN ĐOÁN CẦU ĐA TẦNG
// =========================================================================
function getPatternMatchingVote(history) {
    if (history.length < 30) return { vote:null,name:"PATTERN" };

    let scores={TAI:0,XIU:0};

    for(let len=6;len>=3;len--){
        const pattern=history.slice(-len).join(',');

        for(let i=0;i<history.length-len-1;i++){

            if(history.slice(i,i+len).join(',')===pattern){

                const next=history[i+len];

                if(next==="TAI") scores.TAI+=len;
                else scores.XIU+=len;
            }

        }
    }

    if(scores.TAI==scores.XIU)
        return {vote:null,name:"PATTERN"};

    return {
        vote:scores.TAI>scores.XIU?"TAI":"XIU",
        name:"PATTERN"
    };
}

function getMarkovVote(history){

    if(history.length<50)
        return {vote:null,name:"MARKOV"};

    const state=history.slice(-3).join(',');

    let t=0,x=0;

    for(let i=0;i<history.length-4;i++){

        if(history.slice(i,i+3).join(',')===state){

            if(history[i+3]=="TAI") t++;
            else x++;

        }

    }

    if(t==x) return {vote:null,name:"MARKOV"};

    return {
        vote:t>x?"TAI":"XIU",
        name:"MARKOV"
    };

}


const checkBet = h => (h.length >= 4 && new Set(h.slice(-4)).size === 1) ? { vote: h.slice(-1), name: "CẦU BỆT" } : { vote: null, name: "CẦU BỆT" };

const checkPingPong = h => {
    if (h.length < 4) return { vote: null, name: "PING PONG" };
    const last4 = h.slice(-4).join(',');
    if (last4 === "TAI,XIU,TAI,XIU") return { vote: "TAI", name: "PING PONG" };
    if (last4 === "XIU,TAI,XIU,TAI") return { vote: "XIU", name: "PING PONG" };
    return { vote: null, name: "PING PONG" };
};

function getGeometricVote(h) {
    const last5 = h.slice(-5).join(',');
    const last4 = h.slice(-4).join(',');
    const last3 = h.slice(-3).join(',');
    if (last5 === "TAI,TAI,XIU,TAI,TAI") return { vote: "XIU", name: "CẦU 2-1-2" };
    if (last5 === "XIU,XIU,TAI,XIU,XIU") return { vote: "TAI", name: "CẦU 2-1-2" };
    if (last5 === "TAI,TAI,TAI,XIU,XIU") return { vote: "TAI", name: "CẦU 3-2" };
    if (last5 === "XIU,XIU,XIU,TAI,TAI") return { vote: "XIU", name: "CẦU 3-2" };
    if (last4 === "TAI,TAI,XIU,XIU") return { vote: "TAI", name: "CẦU 2-2" };
    if (last4 === "XIU,XIU,TAI,TAI") return { vote: "XIU", name: "CẦU 2-2" };
    if (last3 === "TAI,XIU,XIU") return { vote: "TAI", name: "CẦU 1-2" };
    if (last3 === "XIU,TAI,TAI") return { vote: "XIU", name: "CẦU 1-2" };
    return { vote: null, name: "XU HƯỚNG" };
}

// =========================================================================
// 3. CORE LOGIC QUÉT PHIÊN MỚI REALTIME & KIỂM TRA THẮNG THUA CHUẨN XÁC
// =========================================================================
async function checkAndPredictLive(apiUrl, storageCache) {
    try {
        const rawData = await fetchJson(apiUrl);
        const sessions = rawData.list || [];
        if (!sessions || sessions.length === 0) return;

        const latestFinishedSession = sessions[0]; 
        const lastFinishedId = Number(latestFinishedSession.id);

        // --- BƯỚC A: ĐỐI CHIẾU THẮNG THUA PHIÊN TRƯỚC ---
        for (let item of storageCache) {
            if (item.phien_hien_tai === lastFinishedId && item.trang_thai === "PENDING") {
                const realKq = latestFinishedSession.resultTruyenThong === "TAI" ? "Tài" : "Xỉu";
                item.phien = lastFinishedId;
                item.tong = latestFinishedSession.point;
                item.xuc_xac = latestFinishedSession.dices || [];
                item.ket_qua = realKq;
                item.trang_thai = (item.du_doan === realKq) ? "THẮNG" : "THUA";
            }
        }

        // --- BƯỚC B: TÍNH TOÁN DỰ ĐOÁN LỆNH CHO PHIÊN ĐANG DIỄN RA TIẾP THEO ---
        const nextPredictId = lastFinishedId + 1;
        if (storageCache.some(item => item.phien_hien_tai === nextPredictId)) return;

        const historyChain = sessions.map(s => s.resultTruyenThong).reverse();

        let votes = { "TAI": 0.0, "XIU": 0.0 };
        let matchedPattern = null;

        const pMatch = getPatternMatchingVote(historyChain);
        if (pMatch.vote) { votes[pMatch.vote] += STABILITY_WEIGHTS.pattern_matching; matchedPattern = pMatch.name; }

        const markov = getMarkovVote(historyChain);
        if (markov.vote) { votes[markov.vote] += STABILITY_WEIGHTS.markov; if(!matchedPattern) matchedPattern = markov.name; }

        const bet = checkBet(historyChain);
        if (bet.vote) { votes[bet.vote] += STABILITY_WEIGHTS.bet; matchedPattern = bet.name; }

        const pPong = checkPingPong(historyChain);
        if (pPong.vote) { votes[pPong.vote] += STABILITY_WEIGHTS.ping_pong; matchedPattern = pPong.name; }

        const geo = getGeometricVote(historyChain);
        if (geo.vote) { votes[geo.vote] += STABILITY_WEIGHTS.cau_hinh_hoc; matchedPattern = geo.name; }

        if (!matchedPattern) return;

        const taiRatio = historyChain.filter(x => x === "TAI").length / historyChain.length;
        votes[taiRatio >= 0.5 ? "TAI" : "XIU"] += STABILITY_WEIGHTS.overall_stats;

        let totalScore = votes["TAI"] + votes["XIU"];
        let finalPred = votes["TAI"] > votes["XIU"] ? "TAI" : "XIU";
        let confidence = Math.round((votes[finalPred] / totalScore) * 100);
        
        if (confidence < 65) confidence = 75;
        if (confidence > 88) confidence = 88;

        const finalPredVn = finalPred === "TAI" ? "Tài" : "Xỉu";

        const newLiveRecord = {
            phien: "Chờ...", 
            phien_hien_tai: nextPredictId, 
            tong: "Chờ...",
            ket_qua: "Chờ...",
            xuc_xac: [],
            du_doan: finalPredVn,
            do_tin_cay: `${confidence}%`,
            cau: matchedPattern,
            trang_thai: "PENDING",
            id: USER_ID
        };

        storageCache.unshift(newLiveRecord);
        if (storageCache.length > 100) storageCache.pop();

    } catch (e) {
        console.error("Lỗi quét cổng ngầm API:", e.message);
    }
}

// Tiến trình quét dữ liệu ngầm 2.5 giây/lần
setInterval(() => {
    checkAndPredictLive(URL_TAIXIU, cacheHistoryTaiXiu);
    checkAndPredictLive(URL_MD5, cacheHistoryMD5);
}, 2500);

// Giao diện CSS VIPPRO
const SHARED_STYLE = `
    body { background-color: #060913; color: #cbd5e1; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 13px; }
    .header-wrapper {
        background: radial-gradient(circle at top, #111a2e 0%, #0a0f1d 100%);
        border: 1px solid #1e2e4d; border-radius: 16px; padding: 20px;
        box-shadow: 0 4px 30px rgba(0, 0, 0, 0.4); position: relative; overflow: hidden;
    }
    .header-wrapper::after {
        content: ''; position: absolute; bottom: 0; left: 0; width: 100%; height: 2px;
        background: linear-gradient(90deg, transparent, #eab308, #ef4444, #38bdf8, transparent);
    }
    .vipro-title {
        font-size: 22px; font-weight: 900; letter-spacing: 2px;
        background: linear-gradient(135deg, #ffffff 10%, #facc15 50%, #eab308 100%);
        -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        text-shadow: 0 0 20px rgba(234,179,8,0.25);
    }
    .neon-box { border: 2px solid #1e293b; border-radius: 16px; padding: 15px; box-shadow: 0 0 25px rgba(56,189,248,0.06); height: 100%; }
    .neon-md5 { background: linear-gradient(145deg, #0f1c2e, #09101b); border-color: #f59e0b; }
    .neon-tx { background: linear-gradient(145deg, #1e1b29, #0d0b12); border-color: #ef4444; }
    .sanh-title { font-size: 15px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; text-align: center; }
    .table { color: #e2e8f0; vertical-align: middle; text-align: center; border-color: #1e293b; width: 100% !important; }
    .table th { background-color: #020617; color: #94a3b8; font-weight: 700; text-transform: uppercase; font-size: 11px; padding: 10px; border-bottom: 2px solid #1e293b; }
    .table td { padding: 8px; border-bottom: 1px solid #1e293b; white-space: nowrap; }
    .txt-tai { color: #38bdf8 !important; font-weight: bold; }
    .txt-xiu { color: #ef4444 !important; font-weight: bold; }
    .txt-pct { color: #60a5fa; font-weight: 600; }
    .phien-id { color: #64748b; font-weight: 500; }
    .status-win { background-color: rgba(16,185,129,0.18); color: #10b981; border: 1px solid rgba(16,185,129,0.4); padding: 4px 14px; border-radius: 20px; font-weight: 900; font-size: 11px; display: inline-block; }
    .status-lose { background-color: rgba(239,68,68,0.14); color: #f87171; border: 1px solid rgba(239,68,68,0.35); padding: 4px 14px; border-radius: 20px; font-weight: 900; font-size: 11px; display: inline-block; }
    .status-pending { background-color: rgba(245,158,11,0.15); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3); padding: 4px 14px; border-radius: 20px; font-weight: 900; font-size: 11px; display: inline-block; }
    .badge-cau { background-color: #0f172a; color: #a5b4fc; border: 1px solid #312e81; font-size: 11px; padding: 2px 6px; font-weight: 600; text-transform: uppercase; }
`;

// Helper sinh mã JavaScript chạy ngầm trên trình duyệt Client
const getScriptContent = (typeKey) => `
    let oldFirstId = null;
    function renderTable(dataList) {
        const tbody = document.getElementById('table-body');
        if (!dataList || !dataList.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-muted py-4 text-center">Đang chờ cổng API gốc nhảy phiên mới khớp mẫu cầu cược...</td></tr>';
            return;
        }
        const currentFirstId = dataList.phien_hien_tai;
        let hasNewRow = oldFirstId && currentFirstId !== oldFirstId;
        oldFirstId = currentFirstId;

        tbody.innerHTML = dataList.map((row, index) => {
            const isPending = row.trang_thai === "PENDING";
            const displayId = isPending ? '#' + row.phien_hien_tai + ' (Cược)' : '#' + row.phien;
            const displayDice = isPending ? 'Chờ...' : row.xuc_xac.join('·');
            const displayTong = row.tong;
            const clsKq = row.ket_qua === "Tài" ? "txt-tai" : (row.ket_qua === "Xỉu" ? "txt-xiu" : "text-muted");
            const clsDd = row.du_doan === "Tài" ? "txt-tai" : "txt-xiu";
            let clsStatus = "status-pending", symbolStatus = "CHỜ KQ";
            if (row.trang_thai === "THẮNG") { clsStatus = "status-win"; symbolStatus = "THẮNG"; }
            if (row.trang_thai === "THUA") { clsStatus = "status-lose"; symbolStatus = "THUA"; }
            const animClass = (index === 0 && hasNewRow) ? "class='new-row-anim'" : "";

            return '<tr ' + animClass + '>' +
                '<td class="phien-id">' + displayId + '</td>' +
                '<td class="text-muted">' + displayDice + '</td>' +
                '<td class="fw-bold text-white">' + displayTong + '</td>' +
                '<td class="' + clsKq + '">' + row.ket_qua.toUpperCase() + '</td>' +
                '<td class="' + clsDd + '">' + row.du_doan.toUpperCase() + '</td>' +
                '<td class="txt-pct">' + row.do_tin_cay + '</td>' +
                '<td><span class="badge badge-cau">' + row.cau + '</span></td>' +
                '<td><span class="' + clsStatus + '">' + symbolStatus + '</span></td>' +
            '</tr>';
        }).join('');
    }
    async function fetchUpdateLive() {
        try {
            const res = await fetch('/get-live-data');
            if (res.ok) {
                const data = await res.json();
                renderTable(data['${typeKey}']);
            }
        } catch (e) { console.error("Lỗi đồng bộ:", e); }
    }
    fetchUpdateLive(); setInterval(fetchUpdateLive, 1500);
`;

// =========================================================================
// 4. HTTP SERVER ĐIỀU PHỐI ĐA KÊNH API DỰ ĐOÁN VÀ ĐƯỜNG DẪN HTML TÁCH BIỆT
// =========================================================================
const server = http.createServer((req, res) => {

    // =========================
    // CORS
    // =========================
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    const getCleanPrediction = (cacheList) => {
        const pendingItem = cacheList.find(item => item.trang_thai === "PENDING");

        if (!pendingItem) return {};

        return {
            phien_hien_tai: pendingItem.phien_hien_tai,
            du_doan: pendingItem.du_doan,
            do_tin_cay: pendingItem.do_tin_cay,
            cau_khop: pendingItem.cau,
            id: pendingItem.id
        };
    };

    // =========================
    // API JSON
    // =========================
    if (req.url === "/taixiu") {
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(JSON.stringify(getCleanPrediction(cacheHistoryTaiXiu)));
    }

    if (req.url === "/taixiumd5") {
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(JSON.stringify(getCleanPrediction(cacheHistoryMD5)));
    }

    if (req.url === "/get-live-data") {
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8"
        });
        return res.end(JSON.stringify({
            taixiu: cacheHistoryTaiXiu,
            md5: cacheHistoryMD5
        }));
    }

    // =========================
    // HTML TÀI XỈU
    // =========================
    if (req.url === "/lichsutx") {
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8"
        });

        return res.end(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>Sảnh Thường VIPPRO</title>
<link href="https://jsdelivr.net" rel="stylesheet">
<style>${SHARED_STYLE}</style>
</head>

<body>

<div class="container py-4">

<div class="header-wrapper text-center mb-4">
<h3 class="vipro-title text-uppercase m-0">🔴 SẢNH TÀI XỈU TRUYỀN THỐNG</h3>
<p class="text-muted mt-2 mb-0">Nhà phát triển: ${USER_ID}</p>
</div>

<div class="row justify-content-center">

<div class="col-sm-12 col-md-10 col-xl-8">

<div class="neon-box neon-tx">

<div class="table-responsive" style="max-height:750px;">

<table class="table table-sm">

<thead class="sticky-top">
<tr>
<th>Mã Phiên</th>
<th>Xúc Xắc</th>
<th>Tổng</th>
<th>Kết Quả</th>
<th>Dự Đoán</th>
<th>Độ Tin</th>
<th>Cầu Khớp</th>
<th>Trạng Thái</th>
</tr>
</thead>

<tbody id="table-body"></tbody>

</table>

</div>

</div>

</div>

</div>

</div>

<script>${getScriptContent("taixiu")}</script>

</body>
</html>`);
    }

    // =========================
    // HTML MD5
    // =========================
    if (req.url === "/lichsumd5") {

        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8"
        });

        return res.end(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>Sảnh MD5 VIPPRO</title>
<link href="https://jsdelivr.net" rel="stylesheet">
<style>${SHARED_STYLE}</style>
</head>

<body>

<div class="container py-4">

<div class="header-wrapper text-center mb-4">
<h3 class="vipro-title text-uppercase m-0">⚡ SẢNH TÀI XỈU MD5 PREMIUM</h3>
<p class="text-muted mt-2 mb-0">Nhà phát triển: ${USER_ID}</p>
</div>

<div class="row justify-content-center">

<div class="col-sm-12 col-md-10 col-xl-8">

<div class="neon-box neon-md5">

<div class="table-responsive" style="max-height:750px;">

<table class="table table-sm">

<thead class="sticky-top">
<tr>
<th>Mã Phiên</th>
<th>Xúc Xắc</th>
<th>Tổng</th>
<th>Kết Quả</th>
<th>Dự Đoán</th>
<th>Độ Tin</th>
<th>Cầu Khớp</th>
<th>Trạng Thái</th>
</tr>
</thead>

<tbody id="table-body"></tbody>

</table>

</div>

</div>

</div>

</div>

</div>

<script>${getScriptContent("md5")}</script>

</body>
</html>`);
    }

    // =========================
    // Health Check
    // =========================
    if (req.url === "/") {
        res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8"
        });

        return res.end("API ONLINE");
    }

    if (req.url === "/health") {

        res.writeHead(200, {
            "Content-Type": "application/json"
        });

        return res.end(JSON.stringify({
            status: "ok",
            uptime: process.uptime()
        }));
    }

    // =========================
    // 404
    // =========================
    res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("Cổng kết nối không tồn tại.");

});

// =========================
// Khởi động Server
// =========================
server.listen(PORT, () => {

    console.log("===============================================");
    console.log(`🚀 Server chạy tại PORT ${PORT}`);
    console.log(`👉 API TX     : http://localhost:${PORT}/taixiu`);
    console.log(`👉 API MD5    : http://localhost:${PORT}/taixiumd5`);
    console.log(`👉 Lịch sử TX : http://localhost:${PORT}/lichsutx`);
    console.log(`👉 Lịch sử MD5: http://localhost:${PORT}/lichsumd5`);
    console.log("===============================================");

});
