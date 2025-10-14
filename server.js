const express = require('express');
const http = require('http');
const cors = require('cors');
// Cần cài đặt thư viện axios: npm install axios
const axios = require('axios'); 

const app = express();
app.use(cors());
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const SUNWIN_API_URL = 'https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid=vgmn_100';

// --- CẤU HÌNH THUẬT TOÁN ĐẠT CHUẨN XÁC TỐI ĐA ---
const HISTORY_MIN_SIZE = 100;    
const ANALYSIS_WINDOW = 100;     
const PREDICTION_WINDOW = 50;    
const CONFIDENCE_THRESHOLD = 70; 
const MAX_PREDICTION_HISTORY = 30; 
const DUAL_PATTERN_LENGTH = 3;   

// --- CẤU HÌNH PHÂN TÍCH MẪU CẦU MỚI (/pattern) ---
const PATTERN_LENGTH = 15; 
const MAX_PATTERN_SAMPLES = 10000; 

// --- BIẾN TOÀN CỤC ---
let history = []; 
let latestPrediction = {
    phien: null,
    duDoan: "Đang chờ kết quả mới...",
    doTinCay: "0%"
};
let predictionHistory = []; 
let latestSessionId = 0; // Lưu ID phiên cuối cùng đã xử lý
let predictionInterval = null; // Biến cho hàm Polling

// --- BIẾN THỐNG KÊ MỚI ---
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
// (Giữ nguyên các hàm checkPattern, checkBet, EXTENDED_PATTERNS, analyzeDualPattern, detectPattern, analyzeDicePatterns, calculateConfidence, predictNextResult)
// ... [Các hàm cơ sở ở trên giữ nguyên như trong yêu cầu của bạn]
// ===================================================================

/** Hàm kiểm tra mẫu cầu chung (Giữ nguyên) */
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
        // Tăng điểm nếu mẫu lặp lại nhiều
        const matchRatio = (matchCount * patternLength) / results.length;
        return matchRatio * (matchCount / 1.5); 
    }
    return 0;
}

/** Hàm kiểm tra cầu Bệt (Giữ nguyên) */
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
    
    return maxStreak >= minLength ? (maxStreak / results.length) * 1.2 : 0;
}

/** Danh sách các mẫu cầu chính thức (Giữ nguyên) */
const EXTENDED_PATTERNS = [
    // Cầu chính (Trọng số cao)
    { name: 'bệt', check: (r) => checkBet(r, 6), minLength: 6, weight: 0.55 }, 
    { name: '1-1', check: (r) => checkPattern(r, '1-1', 4), minLength: 4, weight: 0.45 }, 
    { name: '2-2', check: (r) => checkPattern(r, '2-2', 6), minLength: 6, weight: 0.35 },
    { name: '3-3', check: (r) => checkPattern(r, '3-3', 8), minLength: 8, weight: 0.40 }, 

    // Cầu mới và phức tạp
    { name: '1-1-1', check: (r) => checkPattern(r, '1-1-1', 5), minLength: 5, weight: 0.35 }, // Mẫu 1-1-1
    { name: '1-2-3', check: (r) => checkPattern(r, '1-2-3', 6), minLength: 6, weight: 0.30 },
    { name: '1-2-2', check: (r) => checkPattern(r, '1-2-2', 5), minLength: 5, weight: 0.25 },
    { name: '3-1-3', check: (r) => checkPattern(r, '3-1-3', 7), minLength: 7, weight: 0.28 },
    
    // Cầu cơ bản khác
    { name: '1-2', check: (r) => checkPattern(r, '1-2', 4), minLength: 4, weight: 0.25 },
    { name: '2-1', check: (r) => checkPattern(r, '2-1', 4), minLength: 4, weight: 0.25 },
    { name: '1-3', check: (r) => checkPattern(r, '1-3', 5), minLength: 5, weight: 0.20 },
    { name: '3-1', check: (r) => checkPattern(r, '3-1', 5), minLength: 5, weight: 0.20 },
    { name: '1-3-1', check: (r) => checkPattern(r, '1-3-1', 5), minLength: 5, weight: 0.22 },
];


/** Phân tích Kép (Kết quả + Tổng điểm) (Giữ nguyên) */
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

        return { expectedResult: result, strength: strength / 5 };
    }

    return { expectedResult: null, strength: 0 };
}


/** Phát hiện mẫu cầu đơn (T/X) (Giữ nguyên) */
function detectPattern(history) {
    if (history.length < 4) return { type: 'unknown', strength: 0 };
    const results = history.slice(0, PREDICTION_WINDOW).map(h => h.result); 
    
    let detectedPattern = { type: 'unknown', strength: 0 };
    for (const pattern of EXTENDED_PATTERNS) {
        if (results.length >= pattern.minLength) {
            const strength = pattern.check(results) * pattern.weight;
            if (strength > detectedPattern.strength) {
                if (strength >= 0.15) { // Ngưỡng tối thiểu để nhận dạng mẫu
                    detectedPattern = { type: pattern.name, strength };
                }
            }
        }
    }
    return detectedPattern;
}

/** Phân tích tổng điểm (Dice Analysis) và Mean Reversion (Giữ nguyên) */
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
// --- HÀM TÍNH ĐỘ TIN CẬY CUỐI CÙNG (Giữ nguyên) ---
// ===================================================================

function calculateConfidence(history, pattern, transTotal, dualAnalysis, predictionResult) {
    const totalHistory = history.slice(0, ANALYSIS_WINDOW).length; 
    if (totalHistory < HISTORY_MIN_SIZE) return 50;

    let confidence = 70; 

    // 1. Trụ cột Mẫu Cầu (quan trọng nhất)
    confidence += pattern.strength * 35; 

    // 2. Trụ cột Markov Chain
    if (transTotal >= 5) confidence += 12; 
    else if (transTotal >= 2) confidence += 6;
    
    // 3. Trụ cột Phân tích Kép
    confidence += dualAnalysis.strength * 18; 

    // 4. Trụ cột Cân bằng (Mean Reversion - 100 phiên)
    const recentHistory = history.slice(0, ANALYSIS_WINDOW);
    const taiCount = recentHistory.filter(h => h.result === 'Tài').length;
    const xiuCount = recentHistory.length - taiCount;
    const diff = taiCount - xiuCount;

    if (Math.abs(diff) > 5) {
        if (predictionResult === 'Tài' && diff < 0) confidence += 5; 
        if (predictionResult === 'Xỉu' && diff > 0) confidence += 5; 
        
        if (Math.abs(diff) > 15) confidence -= 10; 
    }
    
    return Math.min(Math.max(confidence, 40), 99); 
}

// ===================================================================
// --- HÀM DỰ ĐOÁN CHÍNH (QUYẾT ĐỊNH CUỐI CÙNG) (Giữ nguyên) ---
// ===================================================================

function predictNextResult(history) {
    if (history.length < HISTORY_MIN_SIZE) {
        return { result: "Đang thu thập dữ liệu...", confidence: 0 };
    }

    const recentHistory = history.slice(0, PREDICTION_WINDOW);
    const pattern = detectPattern(history);
    const diceAnalysis = analyzeDicePatterns(history);
    const dualAnalysis = analyzeDualPattern(history);
    
    let taiProb = 1.0, xiuProb = 1.0; 
    const recentResults = history.map(h => h.result[0]);

    // 1. Trọng số Markov Chain (Order 3)
    const order = 3; 
    const transitions = {};
    for (let i = 0; i < history.length - order; i++) {
        const key = recentResults.slice(i, i + order).join(''); 
        const next = history[i + order].result;
        transitions[key] = transitions[key] || { 'Tài': 0, 'Xỉu': 0 };
        transitions[key][next]++;
    }
    const lastKey = recentResults.slice(0, order).join('');
    let transTotal = 0;
    if (transitions[lastKey]) {
        transTotal = transitions[lastKey]['Tài'] + transitions[lastKey]['Xỉu'];
        if (transTotal >= 3) { 
            taiProb += (transitions[lastKey]['Tài'] / transTotal) * 1.5; 
            xiuProb += (transitions[lastKey]['Xỉu'] / transTotal) * 1.5;
        }
    }

    // 2. Trọng số Phân tích Kép (Total + Result)
    if (dualAnalysis.expectedResult) {
        const dualWeight = dualAnalysis.strength * 1.0; 
        if (dualAnalysis.expectedResult === 'Tài') {
            taiProb += dualWeight;
        } else {
            xiuProb += dualWeight;
        }
    }

    // 3. Trọng số Mẫu Cầu (PATTERN) - Cầu chính/Bẻ cầu
    const lastResult = recentHistory[0].result;

    if (pattern.type !== 'unknown' && pattern.strength >= 0.20) {
        
        const currentPattern = EXTENDED_PATTERNS.find(p => p.name === pattern.type);
        let patternWeight = currentPattern.weight * 3.5; 
        
        if (pattern.type.includes('bệt')) {
            // LOGIC BẺ CẦU BỆT DÀI (Khi bệt >= 10)
            let streakLength = 1;
            for (let i = 1; i < recentHistory.length; i++) { if (recentHistory[i].result === lastResult) streakLength++; else break; }
            
            if (streakLength >= 10) { 
                 console.log(`[DỰ ĐOÁN BẺ CẦU] 🚨 Bệt quá dài (${streakLength}) - Tăng xác suất BẺ. Trọng số x3.`);
                 patternWeight *= 0.1; 
                 if (lastResult === 'Tài') { xiuProb += 3.0; } 
                 else { taiProb += 3.0; }
            } else {
                 // TIẾP CẦU BỆT
                 if (lastResult === 'Tài') taiProb += patternWeight; else xiuProb += patternWeight; 
            }

        } else { 
            // TIẾP CẦU KHÁC (Dự đoán ngược lại)
            const expectedNextPattern = lastResult === 'Tài' ? 'Xỉu' : 'Tài'; 
            
            if (pattern.strength >= 0.7) patternWeight *= 1.5;

            if (expectedNextPattern === 'Tài') taiProb += patternWeight; else xiuProb += patternWeight;
        }
    } 
    
    // 4. Trọng số Phân tích Tổng điểm & Cân bằng (Mean Reversion)
    if (diceAnalysis.sumTrend === 'increasing') taiProb += 0.3;
    else if (diceAnalysis.sumTrend === 'decreasing') xiuProb += 0.3;
    
    if (diceAnalysis.avgSum > 11.5) taiProb += 0.2;
    else if (diceAnalysis.avgSum < 9.5) xiuProb += 0.2;
    
    const analysisHistory = history.slice(0, ANALYSIS_WINDOW);
    const taiCount = analysisHistory.filter(h => h.result === 'Tài').length;
    const xiuCount = analysisHistory.length - taiCount;
    
    if (taiCount > xiuCount + 8) { 
        xiuProb += 0.8;
    } else if (xiuCount > taiCount + 8) { 
        taiProb += 0.8;
    }

    // 5. Chuẩn hóa và Quyết định
    const totalProb = taiProb + xiuProb;
    taiProb /= totalProb;
    xiuProb /= totalProb;

    const result = taiProb > xiuProb ? 'Tài' : 'Xỉu';
    const confidence = calculateConfidence(history, pattern, transTotal, dualAnalysis, result); 
    
    // 6. Quyết định cuối cùng: CHỈ DỰ ĐOÁN KHI >= 70%
    if (confidence < CONFIDENCE_THRESHOLD) {
        return { result: "Không chắc chắn, bỏ qua", confidence: Math.round(confidence) };
    }

    return { result, confidence: Math.round(confidence) };
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
// --- HÀM PHÂN TÍCH MẪU CẦU CHO ENDPOINT MỚI (Nâng cấp định dạng) ---
// ===================================================================

/**
 * Thu thập các mẫu cầu cố định (ví dụ: 15 phiên) và kết quả tiếp theo từ lịch sử.
 */
function extractAndCountPatterns(history, patternLength, maxSamples) {
    // Chỉ sử dụng các kết quả 'T' (Tài) và 'X' (Xỉu)
    // Sẽ lấy phiên mới nhất ở vị trí [0]
    const results = history.map(h => h.result[0]); 
    const patternMap = {};
    let totalSamples = 0;
    
    const availableLength = results.length;
    if (availableLength < patternLength + 1) {
        return { patternMap: {}, totalSamples: 0 };
    }

    // Duyệt qua lịch sử để trích xuất mẫu và kết quả tiếp theo
    // Bắt đầu từ phiên thứ patternLength + 1 trở đi (index = patternLength)
    for (let i = patternLength; i < availableLength && totalSamples < maxSamples; i++) {
        // Mẫu: patternLength phiên ngay trước kết quả (slice(start, end) -> end không bao gồm)
        // Mẫu lịch sử: results.slice(i - patternLength, i)
        // Lưu ý: history của bạn được unshift (phiên mới nhất ở đầu), nên khi lấy slice, mẫu sẽ được đọc ngược
        // Để giữ tính nhất quán, ta đảo ngược mảng kết quả results trước khi slice
        const reversedResults = [...results].reverse(); 
        
        // Mẫu là chuỗi (patternLength) kết quả liền kề nhau: XÃ-XA-NÓNG
        const pattern = results.slice(i - patternLength, i).reverse().join(''); 
        // Kết quả tiếp theo (phiên thứ i)
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
// --- CHỨC NĂNG LẤY DỮ LIỆU TỪ HTTP API VÀ XỬ LÝ (THAY THẾ WS) ---
// ===================================================================

async function fetchAndProcessData() {
    try {
        const response = await axios.get(SUNWIN_API_URL);
        const data = response.data.data;

        if (!data || data.length === 0) {
            console.log('API trả về dữ liệu rỗng.');
            return;
        }

        // Tìm kiếm đối tượng có kết quả (chứa d1, d2, d3, cmd=2006)
        const resultObject = data.find(item => item.cmd === 2006 && item.sid && item.d1);

        if (resultObject) {
            const newSession = Number(resultObject.sid);
            
            // Chỉ xử lý nếu phiên mới lớn hơn phiên cuối cùng đã xử lý
            if (newSession > latestSessionId) {
                const dice = [Number(resultObject.d1), Number(resultObject.d2), Number(resultObject.d3)];
                const total = dice.reduce((a, b) => a + b, 0);
                const result = total >= 11 ? 'Tài' : 'Xỉu';

                console.log(`\n🎉 Phát hiện phiên mới: #${newSession}. Kết quả: ${result} (${dice.join('-')})`);

                // --- BƯỚC 1: CẬP NHẬT THỐNG KÊ (Cho phiên vừa kết thúc) ---
                if (pendingPrediction && pendingPrediction.phien === newSession) {
                    updateStats(newSession, result); 
                }
                
                // --- BƯỚC 2: THÊM VÀO LỊCH SỬ ---
                history.unshift({ result, total, dice, session: newSession, timestamp: new Date().toISOString() });
                if (history.length > MAX_PATTERN_SAMPLES + PATTERN_LENGTH + 100) { 
                    history.pop();
                }
                
                latestSessionId = newSession; // Cập nhật phiên cuối cùng đã xử lý

                // --- BƯỚC 3: DỰ ĐOÁN CHO PHIÊN TIẾP THEO ---
                const nextSession = newSession + 1;
                console.log(`\n⏳ Bắt đầu phân tích dự đoán cho phiên #${nextSession} (MAX ACCURACY)...`);
                
                // Giả định thời gian phân tích và quyết định
                const { result: nextResult, confidence } = predictNextResult(history);
                
                const newPrediction = {
                    phien: nextSession,
                    duDoan: nextResult,
                    doTinCay: `${confidence}%`,
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
                     pendingPrediction = null; // Reset nếu không dự đoán
                }
                
                console.log(`[DỰ ĐOÁN CUỐI CÙNG] Phiên #${latestPrediction.phien} | Dự đoán: ${latestPrediction.duDoan} | Độ tin cậy: ${latestPrediction.doTinCay}`);

            } else {
                console.log(`[Polling] Phiên mới nhất #${newSession} đã được xử lý (hoặc nhỏ hơn). Đang chờ phiên tiếp theo...`);
            }
        } else {
             // Tìm kiếm phiên đang chờ (chỉ có sid, cmd=1008)
            const currentSessionObject = data.find(item => item.cmd === 1008 && item.sid);
            if (currentSessionObject) {
                const currentSession = Number(currentSessionObject.sid);
                const nextPrediction = latestPrediction.phien || latestSessionId + 1;
                // Kiểm tra nếu phiên hiện tại khác với phiên đang chờ dự đoán
                if (currentSession !== nextPrediction) {
                    // Nếu API đã chuyển sang phiên mới hơn (chưa có kết quả)
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

/**
 * Bắt đầu Polling API.
 * Giả sử chu kỳ game là 60 giây. Ta poll mỗi 5 giây.
 */
function startPolling() {
    // Chạy lần đầu ngay lập tức
    fetchAndProcessData(); 
    // Thiết lập Polling mỗi 5 giây
    predictionInterval = setInterval(fetchAndProcessData, 5000); 
    console.log(`\n📡 Bắt đầu Polling API Hit (MD5) mỗi 5 giây...`);
}


// ===================================================================
// --- API ENDPOINT ---
// ===================================================================

app.get('/predict', (req, res) => {
    const responseText = `Phiên: #${latestPrediction.phien || '...'} | Dự đoán: ${latestPrediction.duDoan} | Độ Tin Cậy: ${latestPrediction.doTinCay}`;
    res.json({
        prediction_text: responseText,
        data: latestPrediction
    });
});

app.get('/history', (req, res) => {
    const historyData = predictionHistory.map(p => ({
        phien: p.phien,
        duDoan: p.duDoan,
        doTinCay: p.doTinCay,
        thoiGian: new Date(p.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }));

    res.json({
        message: `Lịch sử ${Math.min(predictionHistory.length, MAX_PREDICTION_HISTORY)} phiên dự đoán gần nhất:`,
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

    const responseText = `Hiệu suất dự đoán: Đã dự đoán ${stats.totalPredictions} phiên. Chính xác: ${stats.totalCorrect} (${accuracy}). Chuỗi Thắng Dài Nhất: ${stats.maxWinStreak}. Chuỗi Thua Dài Nhất: ${stats.maxLoseStreak}. Chuỗi Hiện Tại: ${currentStreakText}`;

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


// ===================================================================
// --- API ENDPOINT NÂNG CẤP CHO PHÂN TÍCH MẪU CẦU ---
// ===================================================================
app.get('/pattern', (req, res) => {
    // Thu thập 10000 mẫu cầu từ lịch sử (mỗi mẫu dài 15 phiên)
    const { patternMap, totalSamples } = extractAndCountPatterns(history, PATTERN_LENGTH, MAX_PATTERN_SAMPLES);
    
    // Chuyển đổi định dạng cho dễ đọc và tính xác suất
    const patternList = Object.entries(patternMap).map(([pattern, counts]) => {
        const total = counts.Tài + counts.Xỉu;
        const nextResult = counts.Tài >= counts.Xỉu ? 'Tài' : 'Xỉu';
        const confidence = total > 0 ? ((Math.max(counts.Tài, counts.Xỉu) / total) * 100).toFixed(2) : 0;
        
        return {
            pattern: pattern.replace(/T/g, 't').replace(/X/g, 'x'), // Nâng cấp định dạng: T->t, X->x
            lanXuatHien: total,
            ketQuaTiepTheo: nextResult,
            doTinCay: `${confidence}%`,
            thongKe: counts
        };
    }).sort((a, b) => b.lanXuatHien - a.lanXuatHien); // Sắp xếp mẫu xuất hiện nhiều nhất lên đầu

    res.json({
        message: `Phân tích Mẫu Cầu (${PATTERN_LENGTH} phiên) dựa trên ${totalSamples} mẫu cầu gần nhất:`,
        pattern_length: PATTERN_LENGTH,
        total_samples_analyzed: totalSamples,
        unique_patterns_found: patternList.length,
        pattern_list: patternList
    });
});


server.listen(PORT, () => {
    console.log(`🚀 API server is running on http://localhost:${PORT}`);
    startPolling(); // Thay thế connectWebSocket() bằng startPolling()
});
