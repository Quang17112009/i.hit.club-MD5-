Const express = require('express');
const http = require('http');
const cors = require('cors');
// Cần cài đặt thư viện axios: npm install axios
const axios = require('axios'); 

const app = express();
app.use(cors());
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const SUNWIN_API_URL = 'https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid=vgmn_100';

// ===================================================================
// --- CẤU HÌNH SIÊU THUẬT TOÁN A.I ---
// ===================================================================
const HISTORY_MIN_SIZE = 50;     // Tối thiểu 50 phiên để phân tích
const ANALYSIS_WINDOW = 50;      // Chỉ phân tích 50 phiên gần nhất
const PREDICTION_WINDOW = 50;    // Chỉ dự đoán dựa trên 50 phiên gần nhất
const CONFIDENCE_THRESHOLD = 75; // Ngưỡng tin cậy tối thiểu để đưa ra dự đoán
const MAX_PREDICTION_HISTORY = 30; 
const DUAL_PATTERN_LENGTH = 3;   
const PATTERN_LENGTH = 5; 
const MAX_PATTERN_SAMPLES = 50; 
const MAX_TOTAL_HISTORY = 100; // Giới hạn tổng lịch sử tối đa

// --- BIẾN TOÀN CỤC ---
let history = []; 
let latestPrediction = {
    phien: null,
    duDoan: "Đang chờ kết quả mới...",
    doTinCay: "0%"
};
let predictionHistory = []; 
let latestSessionId = 0; 
let predictionInterval = null; 
let stats = {
    totalPredictions: 0,
    totalCorrect: 0,
    maxWinStreak: 0,
    maxLoseStreak: 0,
    currentWinStreak: 0,
    currentLoseStreak: 0
};
let pendingPrediction = null; 

// ===================================================================
// --- CÁC HÀM CƠ SỞ VÀ MẪU CẦU ---
// ===================================================================

/** Hàm kiểm tra mẫu cầu chung */
function checkPattern(results, pattern, minLength) {
    if (results.length < minLength) return 0;
    const seq = results.map(r => r === 'Tài' ? 'T' : 'X');
    const blockSizes = pattern.split('-').map(Number);
    let matchCount = 0;
    const patternLength = blockSizes.reduce((a, b) => a + b, 0);

    for (let i = 0; i <= seq.length - patternLength; i++) {
        let currentIdx = i;
        let isMatch = true;
        for (let j = 0; j < blockSizes.length; j++) {
            const size = blockSizes[j];
            const expectedResult = j % 2 === 0 ? seq[i] : (seq[i] === 'T' ? 'X' : 'T');
            for (let k = 0; k < size; k++) {
                if (currentIdx >= seq.length || seq[currentIdx] !== expectedResult) {
                    isMatch = false;
                    break;
                }
                currentIdx++;
            }
            if (!isMatch) break;
        }

        if (isMatch) {
            matchCount++;
            i += patternLength - 1;
        }
    }

    if (matchCount > 0) {
        const matchRatio = (matchCount * patternLength) / results.length;
        return matchRatio * (matchCount / 1.0); 
    }
    return 0;
}

/** Hàm kiểm tra cầu Bệt */
function checkBet(results, minLength) {
    if (results.length < minLength) return 0;
    let taiStreak = 0;
    let xiuStreak = 0;
    let maxStreak = 0;
    
    for (let i = 0; i < results.length; i++) {
        if (results[i] === 'Tài') {
            taiStreak++;
            xiuStreak = 0;
        } else {
            xiuStreak++;
            taiStreak = 0;
        }
        maxStreak = Math.max(maxStreak, taiStreak, xiuStreak);
    }
    
    return maxStreak >= minLength ? (maxStreak / results.length) * 1.5 : 0;
}

/** Danh sách các mẫu cầu chính thức (Điều chỉnh minLength để tăng nhạy) */
const EXTENDED_PATTERNS = [
    { name: 'bệt', check: (r) => checkBet(r, 4), minLength: 4, weight: 0.55 }, 
    { name: '1-1', check: (r) => checkPattern(r, '1-1', 4), minLength: 4, weight: 0.45 }, 
    { name: '2-2', check: (r) => checkPattern(r, '2-2', 4), minLength: 4, weight: 0.35 }, 
    { name: '3-3', check: (r) => checkPattern(r, '3-3', 6), minLength: 6, weight: 0.40 }, 
    { name: '1-1-1', check: (r) => checkPattern(r, '1-1-1', 5), minLength: 5, weight: 0.35 }, 
    { name: '1-2-3', check: (r) => checkPattern(r, '1-2-3', 6), minLength: 6, weight: 0.30 },
    { name: '1-2', check: (r) => checkPattern(r, '1-2', 4), minLength: 4, weight: 0.25 },
    { name: '2-1', check: (r) => checkPattern(r, '2-1', 4), minLength: 4, weight: 0.25 },
];


/** Phân tích Kép (Kết quả + Tổng điểm) */
function analyzeDualPattern(history) {
    const dualHistory = history.slice(0, PREDICTION_WINDOW); 
    if (dualHistory.length < DUAL_PATTERN_LENGTH) {
        return { expectedResult: null, strength: 0 };
    }

    const lastPattern = dualHistory
        .slice(0, DUAL_PATTERN_LENGTH)
        .map(h => `${h.result[0]}${h.total}`)
        .reverse()
        .join('-');

    let matchCount = 0;
    let predictedNext = { Tài: 0, Xỉu: 0 };
    
    for (let i = DUAL_PATTERN_LENGTH; i < dualHistory.length - 1; i++) {
        const historicalPattern = dualHistory
            .slice(i - DUAL_PATTERN_LENGTH + 1, i + 1)
            .map(h => `${h.result[0]}${h.total}`)
            .reverse()
            .join('-');
            
        if (historicalPattern === lastPattern) {
            matchCount++;
            const nextResult = dualHistory[i - DUAL_PATTERN_LENGTH].result; 
            predictedNext[nextResult]++;
        }
    }

    if (matchCount > 0) {
        const totalPrediction = predictedNext.Tài + predictedNext.Xỉu;
        const result = predictedNext.Tài > predictedNext.Xỉu ? 'Tài' : 'Xỉu';
        const strength = matchCount * (Math.max(predictedNext.Tài, predictedNext.Xỉu) / totalPrediction); 

        return { expectedResult: result, strength: strength / 3.0 }; 
    }

    return { expectedResult: null, strength: 0 };
}


/** Phát hiện mẫu cầu đơn (T/X) */
function detectPattern(history) {
    if (history.length < 4) return { type: 'unknown', strength: 0 };
    const results = history.slice(0, PREDICTION_WINDOW).map(h => h.result); 
    
    let detectedPattern = { type: 'unknown', strength: 0 };
    for (const pattern of EXTENDED_PATTERNS) {
        if (results.length >= pattern.minLength) {
            const strength = pattern.check(results) * pattern.weight;
            if (strength > detectedPattern.strength) {
                if (strength >= 0.15) { 
                    detectedPattern = { type: pattern.name, strength };
                }
            }
        }
    }
    return detectedPattern;
}

/** Phân tích tổng điểm (Dice Analysis) và Mean Reversion */
function analyzeDicePatterns(history) {
    const diceHistory = history.filter(h => h.dice && h.dice.length === 3).slice(0, ANALYSIS_WINDOW); 
    if (diceHistory.length < 5) return { sumTrend: 'none', sumTrendStrength: 0, avgSum: 10.5 };
    
    const totals = diceHistory.map(h => h.total);
    const recentTotals = totals.slice(0, 5); 
    
    const sumTrend = recentTotals.length === 5 ? (
        recentTotals.every((t, i) => i === 0 || t >= recentTotals[i-1]) ? 'increasing' : 
        recentTotals.every((t, i) => i === 0 || t <= recentTotals[i-1]) ? 'decreasing' : 'stable'
    ) : 'none';
    const sumTrendStrength = sumTrend !== 'stable' ? 0.35 : 0;
    
    const avgSum = totals.reduce((sum, t) => sum + t, 0) / totals.length;
    
    return { sumTrend, sumTrendStrength, avgSum };
}


// ===================================================================
// --- HÀM TÍNH ĐỘ TIN CẬY CUỐI CÙNG (HIỆU CHỈNH) ---
// ===================================================================

function calculateConfidence(history, pattern, transTotal, dualAnalysis, predictionResult, taiScore, xiuScore) {
    const totalHistory = history.slice(0, ANALYSIS_WINDOW).length; 
    if (totalHistory < HISTORY_MIN_SIZE) return 50; 

    // 1. Tính Độ Tin Cậy Cơ Sở (Dựa trên tỷ lệ Score thô)
    let score = predictionResult === 'Tài' ? taiScore : xiuScore;
    let totalScore = taiScore + xiuScore;
    // Bắt đầu với điểm tin cậy tương ứng với xác suất thô (Probability)
    let finalConfidence = (score / totalScore) * 100;

    // --- CÁC YẾU TỐ PHẠT/THƯỞNG HIỆU CHỈNH ---
    const recentHistory = history.slice(0, ANALYSIS_WINDOW);
    const lastResult = recentHistory[0].result;
    
    // 2. Thưởng cho tín hiệu mạnh
    if (pattern.strength >= 0.3) {
        finalConfidence += 7;
    }

    // 3. Phạt nếu AI cố Bẻ Cầu Dài
    let streakLength = 0;
    for (let i = 0; i < recentHistory.length; i++) { 
        if (recentHistory[i].result === lastResult) streakLength++; 
        else break; 
    }
    if (streakLength >= 6 && predictionResult !== lastResult) {
        // AI đang cố bẻ cầu dài (rủi ro cao): Phạt 5 điểm
        finalConfidence -= 5;
    }

    // 4. Phạt nếu dữ liệu đang quá mất cân bằng (Nguy cơ lật cầu)
    const taiCount = recentHistory.filter(h => h.result === 'Tài').length;
    const xiuCount = recentHistory.length - taiCount;
    const diff = Math.abs(taiCount - xiuCount);

    if (diff > 10) { // Lệch hơn 10/50 ván là rủi ro
        console.log(`[HIỆU CHỈNH] Lệch lớn (${diff}). Phạt ${Math.floor(diff / 2)} điểm tin cậy.`);
        finalConfidence -= Math.floor(diff / 2); // Phạt nặng hơn
    }
    
    // 5. Giới hạn tối đa 95% để tránh báo cáo $99\%
    return Math.min(Math.max(Math.round(finalConfidence), 40), 95); 
}

// ===================================================================
// --- HÀM DỰ ĐOÁN CHÍNH (SIÊU THUẬT TOÁN) ---
// ===================================================================

function predictNextResult(history) {
    if (history.length < HISTORY_MIN_SIZE) {
        return { result: "Đang thu thập dữ liệu...", confidence: 0 };
    }
    
    const limitedHistory = history.slice(0, PREDICTION_WINDOW); 

    const pattern = detectPattern(limitedHistory);
    const diceAnalysis = analyzeDicePatterns(limitedHistory);
    const dualAnalysis = analyzeDualPattern(limitedHistory);
    
    let taiScore = 1.0, xiuScore = 1.0; 
    const recentResults = limitedHistory.map(h => h.result[0]);

    // 1. Trọng số Markov Chain (Order 3) - Trọng số cao
    const order = 3; 
    const transitions = {};
    for (let i = 0; i < limitedHistory.length - order; i++) {
        const key = recentResults.slice(i, i + order).join(''); 
        const next = limitedHistory[i + order].result;
        transitions[key] = transitions[key] || { 'Tài': 0, 'Xỉu': 0 };
        transitions[key][next]++;
    }
    const lastKey = recentResults.slice(0, order).join('');
    let transTotal = 0;
    if (transitions[lastKey]) {
        transTotal = transitions[lastKey]['Tài'] + transitions[lastKey]['Xỉu'];
        if (transTotal >= 3) { 
            taiScore += (transitions[lastKey]['Tài'] / transTotal) * 2.5; 
            xiuScore += (transitions[lastKey]['Xỉu'] / transTotal) * 2.5;
        }
    }

    // 2. Trọng số Phân tích Kép (Total + Result)
    if (dualAnalysis.expectedResult) {
        const dualWeight = dualAnalysis.strength * 1.5; 
        if (dualAnalysis.expectedResult === 'Tài') {
            taiScore += dualWeight;
        } else {
            xiuScore += dualWeight;
        }
    }

    // 3. Trọng số Mẫu Cầu (PATTERN) - Phát hiện xu hướng
    const lastResult = limitedHistory[0].result;

    if (pattern.type !== 'unknown' && pattern.strength >= 0.20) {
        
        const currentPattern = EXTENDED_PATTERNS.find(p => p.name === pattern.type);
        let patternWeight = currentPattern.weight * 3.5; 
        
        if (pattern.type.includes('bệt')) {
            let streakLength = 1;
            for (let i = 1; i < limitedHistory.length; i++) { if (limitedHistory[i].result === lastResult) streakLength++; else break; }
            
            if (streakLength >= 8) { 
                 console.log(`[SIÊU AI] 🚨 Bệt cực kỳ DÀI (${streakLength}). TĂNG TỐC BẺ CẦU.`);
                 patternWeight *= 0.1; 
                 if (lastResult === 'Tài') { xiuScore += 4.0; } 
                 else { taiScore += 4.0; }
            } else if (streakLength >= 4) {
                 if (lastResult === 'Tài') taiScore += patternWeight * 1.5; else xiuScore += patternWeight * 1.5; 
            }

        } else { 
            const expectedNextPattern = lastResult === 'Tài' ? 'Xỉu' : 'Tài'; 
            
            if (pattern.strength >= 0.7) patternWeight *= 1.5;
            if (expectedNextPattern === 'Tài') taiScore += patternWeight; else xiuScore += patternWeight;
        }
    } 
    
    // 4. Trọng số Phân tích Tổng điểm & Cân bằng (Mean Reversion)
    if (diceAnalysis.sumTrend === 'increasing') taiScore += 0.5;
    else if (diceAnalysis.sumTrend === 'decreasing') xiuScore += 0.5;
    
    if (diceAnalysis.avgSum > 11.0) taiScore += 0.4;
    else if (diceAnalysis.avgSum < 10.0) xiuScore += 0.4;
    
    const analysisHistory = limitedHistory.slice(0, ANALYSIS_WINDOW);
    const taiCount = analysisHistory.filter(h => h.result === 'Tài').length;
    const xiuCount = analysisHistory.length - taiCount;
    
    if (taiCount > xiuCount + 5) { 
        xiuScore += 1.0; 
    } else if (xiuCount > taiCount + 5) { 
        taiScore += 1.0;
    }

    // 5. Quyết định và HIỆU CHỈNH ĐỘ TIN CẬY
    const result = taiScore > xiuScore ? 'Tài' : 'Xỉu';
    
    const confidence = calculateConfidence(limitedHistory, pattern, transTotal, dualAnalysis, result, taiScore, xiuScore); 
    
    // 6. Quyết định cuối cùng: CHỈ DỰ ĐOÁN KHI >= 75%
    if (confidence < CONFIDENCE_THRESHOLD) {
        return { result: "Không chắc chắn, bỏ qua", confidence: Math.round(confidence) };
    }

    return { 
        result, 
        confidence: Math.round(confidence),
        taiScore: taiScore.toFixed(2),
        xiuScore: xiuScore.toFixed(2)
    };
}


// ===================================================================
// --- HÀM CẬP NHẬT THỐNG KÊ (Giữ nguyên) ---
// ===================================================================

function updateStats(newSession, actualResult) {
    if (pendingPrediction && pendingPrediction.phien === newSession) {
        
        const isCorrect = pendingPrediction.duDoan === actualResult;
        
        if (pendingPrediction.duDoan !== "Không chắc chắn, bỏ qua") { 
            stats.totalPredictions++;

            if (isCorrect) {
                stats.totalCorrect++;
                stats.currentWinStreak++;
                stats.currentLoseStreak = 0;
                stats.maxWinStreak = Math.max(stats.maxWinStreak, stats.currentWinStreak);
                
                console.log(`[THỐNG KÊ] ✅ Dự đoán ĐÚNG! Phiên #${newSession}. Chuỗi thắng hiện tại: ${stats.currentWinStreak}`);
            } else {
                stats.currentLoseStreak++;
                stats.currentWinStreak = 0;
                stats.maxLoseStreak = Math.max(stats.maxLoseStreak, stats.currentLoseStreak);
                
                console.log(`[THỐNG KÊ] ❌ Dự đoán SAI. Phiên #${newSession}. Chuỗi thua hiện tại: ${stats.currentLoseStreak}`);
            }
        } else {
            console.log(`[THỐNG KÊ] Phiên #${newSession} bị bỏ qua, không ảnh hưởng chuỗi thắng/thua.`);
        }

        pendingPrediction = null; 
    }
}


// ===================================================================
// --- HÀM PHÂN TÍCH MẪU CẦU CHO ENDPOINT MỚI ---
// ===================================================================

/** Thu thập và đếm các mẫu cầu cố định (PATTERN_LENGTH) và kết quả tiếp theo từ 50 phiên gần nhất. */
function extractAndCountPatterns(history, patternLength, maxSamples) {
    const results = history.map(h => h.result[0]); 
    const patternMap = {};
    let totalSamples = 0;
    
    const availableLength = results.length;
    if (availableLength < patternLength + 1) {
        return { patternMap: {}, totalSamples: 0 };
    }

    const limit = Math.min(availableLength, maxSamples + patternLength); 
    
    for (let i = patternLength; i < limit; i++) {
        const pattern = results.slice(i - patternLength, i).reverse().join(''); 
        const nextResult = history[i].result[0]; 

        if (!patternMap[pattern]) {
            patternMap[pattern] = { Tài: 0, Xỉu: 0 };
        }
        
        if (nextResult === 'T') {
            patternMap[pattern].Tài++;
        } else if (nextResult === 'X') {
            patternMap[pattern].Xỉu++;
        }
        
        totalSamples++;
    }

    return { patternMap, totalSamples };
}


// ===================================================================
// --- HÀM LẤY DỮ LIỆU TỪ HTTP API VÀ XỬ LÝ (Polling) ---
// ===================================================================

async function fetchAndProcessData() {
    try {
        const response = await axios.get(SUNWIN_API_URL);
        const data = response.data.data;

        if (!data || data.length === 0) {
            console.log('API trả về dữ liệu rỗng.');
            return;
        }

        const resultObject = data.find(item => item.cmd === 2006 && item.sid && item.d1);

        if (resultObject) {
            const newSession = Number(resultObject.sid);
            
            if (newSession > latestSessionId) {
                const dice = [Number(resultObject.d1), Number(resultObject.d2), Number(resultObject.d3)];
                const total = dice.reduce((a, b) => a + b, 0);
                const result = total >= 11 ? 'Tài' : 'Xỉu';

                console.log(`\n🎉 Phát hiện phiên mới: #${newSession}. Kết quả: ${result} (${dice.join('-')})`);

                // --- BƯỚC 1: CẬP NHẬT THỐNG KÊ ---
                if (pendingPrediction && pendingPrediction.phien === newSession) {
                    updateStats(newSession, result); 
                }
                
                // --- BƯỚC 2: THÊM VÀO LỊCH SỬ ---
                history.unshift({ result, total, dice, session: newSession, timestamp: new Date().toISOString() });
                if (history.length > MAX_TOTAL_HISTORY) { 
                    history.pop();
                }
                
                latestSessionId = newSession;

                // --- BƯỚC 3: DỰ ĐOÁN CHO PHIÊN TIẾP THEO ---
                const nextSession = newSession + 1;
                console.log(`\n⏳ Bắt đầu phân tích dự đoán cho phiên #${nextSession} (SIÊU THUẬT TOÁN A.I)...`);
                
                const { result: nextResult, confidence, taiScore, xiuScore } = predictNextResult(history);
                
                const newPrediction = {
                    phien: nextSession,
                    duDoan: nextResult,
                    doTinCay: `${confidence}%`,
                    taiScore: taiScore,
                    xiuScore: xiuScore,
                    timestamp: new Date().toISOString()
                };
                
                latestPrediction = newPrediction;
                predictionHistory.unshift(newPrediction);
                if (predictionHistory.length > MAX_PREDICTION_HISTORY) {
                    predictionHistory.pop();
                }
                
                // --- BƯỚC 4: LƯU DỰ ĐOÁN ĐANG CHỜ KẾT QUẢ ---
                if (newPrediction.duDoan !== "Không chắc chắn, bỏ qua") {
                     pendingPrediction = newPrediction;
                } else {
                     pendingPrediction = null; 
                }
                
                console.log(`[DỰ ĐOÁN CUỐI CÙNG] Phiên #${latestPrediction.phien} | Dự đoán: ${latestPrediction.duDoan} | Độ tin cậy: ${latestPrediction.doTinCay} (Tài: ${latestPrediction.taiScore}, Xỉu: ${latestPrediction.xiuScore})`);

            } else {
                console.log(`[Polling] Phiên mới nhất #${newSession} đã được xử lý. Đang chờ phiên tiếp theo...`);
            }
        } else {
            const currentSessionObject = data.find(item => item.cmd === 1008 && item.sid);
            if (currentSessionObject) {
                const currentSession = Number(currentSessionObject.sid);
                const nextPrediction = latestPrediction.phien || latestSessionId + 1;
                if (currentSession !== nextPrediction) {
                    console.log(`[Polling] Đang ở phiên #${currentSession} (chưa có kết quả). Phiên dự đoán hiện tại: #${nextPrediction}`);
                }
            } else {
                console.log('[Polling] Không tìm thấy đối tượng kết quả hợp lệ trong phản hồi API.');
            }
        }
    } catch (error) {
        console.error('❌ Lỗi khi gọi API SunWin:', error.message);
    }
}

/** Bắt đầu Polling API. */
function startPolling() {
    fetchAndProcessData(); 
    predictionInterval = setInterval(fetchAndProcessData, 5000); 
    console.log(`\n📡 Bắt đầu Polling API Hit (MD5) mỗi 5 giây...`);
}


// ===================================================================
// --- API ENDPOINT ---
// ===================================================================

app.get('/predict', (req, res) => {
    const predictionText = latestPrediction.phien ? 
        `Phiên: #${latestPrediction.phien} | Dự đoán: ${latestPrediction.duDoan} | Độ Tin Cậy: ${latestPrediction.doTinCay} (Tài: ${latestPrediction.taiScore || 'N/A'}, Xỉu: ${latestPrediction.xiuScore || 'N/A'})` :
        latestPrediction.duDoan;
        
    res.json({
        prediction_text: predictionText,
        data: latestPrediction
    });
});

app.get('/history', (req, res) => {
    const historyData = predictionHistory.map(p => ({
        phien: p.phien,
        duDoan: p.duDoan,
        doTinCay: p.doTinCay,
        taiScore: p.taiScore,
        xiuScore: p.xiuScore,
        thoiGian: new Date(p.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }));

    res.json({
        message: `Lịch sử ${Math.min(predictionHistory.length, MAX_PREDICTION_HISTORY)} phiên dự đoán gần nhất (SIÊU AI):`,
        history: historyData
    });
});

app.get('/stats', (req, res) => {
    const accuracy = stats.totalPredictions > 0 
        ? ((stats.totalCorrect / stats.totalPredictions) * 100).toFixed(2) + '%'
        : 'N/A';
    
    const currentStreakText = stats.currentWinStreak > 0 
        ? `Thắng ${stats.currentWinStreak}` 
        : (stats.currentLoseStreak > 0 ? `Thua ${stats.currentLoseStreak}` : 'Đang chờ');

    const responseText = `Hiệu suất dự đoán (SIÊU THUẬT TOÁN): Đã dự đoán ${stats.totalPredictions} phiên. Chính xác: ${stats.totalCorrect} (${accuracy}). Chuỗi Thắng Dài Nhất: ${stats.maxWinStreak}. Chuỗi Thua Dài Nhất: ${stats.maxLoseStreak}. Chuỗi Hiện Tại: ${currentStreakText}`;

    res.json({
        message: 'Thống kê hiệu suất AI (Chỉ tính các phiên có dự đoán):',
        totalPredictions: stats.totalPredictions,
        totalCorrect: stats.totalCorrect,
        accuracy: accuracy,
        maxWinStreak: stats.maxWinStreak,
        maxLoseStreak: stats.maxLoseStreak,
        currentWinStreak: stats.currentWinStreak,
        currentLoseStreak: stats.currentLoseStreak,
        prediction_summary: responseText
    });
});

app.get('/pattern', (req, res) => {
    const { patternMap, totalSamples } = extractAndCountPatterns(history, PATTERN_LENGTH, MAX_PATTERN_SAMPLES);
    
    const patternList = Object.entries(patternMap).map(([pattern, counts]) => {
        const total = counts.Tài + counts.Xỉu;
        const nextResult = counts.Tài >= counts.Xỉu ? 'Tài' : 'Xỉu';
        const confidence = total > 0 ? ((Math.max(counts.Tài, counts.Xỉu) / total) * 100).toFixed(2) : 0;
        
        return {
            pattern: pattern.replace(/T/g, 't').replace(/X/g, 'x'), 
            lanXuatHien: total,
            ketQuaTiepTheo: nextResult,
            doTinCay: `${confidence}%`,
            thongKe: counts
        };
    }).sort((a, b) => b.lanXuatHien - a.lanXuatHien); 

    res.json({
        message: `Phân tích Mẫu Cầu (${PATTERN_LENGTH} phiên) dựa trên ${totalSamples} mẫu cầu trong 50 phiên gần nhất (SIÊU AI):`,
        pattern_length: PATTERN_LENGTH,
        total_samples_analyzed: totalSamples,
        unique_patterns_found: patternList.length,
        pattern_list: patternList
    });
});


server.listen(PORT, () => {
    console.log(`🚀 API server is running on http://localhost:${PORT}`);
    startPolling(); 
});
