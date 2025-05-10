const PORT = process.env.PORT || 3000;

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const { createClient } = require('redis');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS 설정 및 CDN 허용
app.use((req, res, next) => {
    // CORS 헤더 설정
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Content-Security-Policy 헤더 설정 - CDN 허용
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.socket.io https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:;"
    );
    
    next();
});

// Socket.IO 설정
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    maxHttpBufferSize: 5 * 1024 * 1024, // 5MB로 버퍼 크기 증가
    pingTimeout: 60000, // 핑 타임아웃 60초로 증가
    pingInterval: 25000 // 핑 간격 25초로 설정
});

// 정적 파일 제공
app.use(express.static(path.join(__dirname, '../frontend')));

// 헬스 체크 API
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: '서버가 정상적으로 실행 중입니다.' });
});



// 오류 처리
server.on('error', (error) => {
    console.error('서버 오류:', error);
    if (error.code === 'EADDRINUSE') {
        console.error(`포트 ${PORT}가 이미 사용 중입니다. 다른 포트를 사용하거나 해당 포트를 사용하는 프로세스를 종료하세요.`);
    }
});

// Redis 클라이언트 생성 및 연결 설정 수정
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

// Redis 연결 설정
(async () => {
    redisClient.on('error', (err) => {
        console.error(`Redis 연결 오류: ${err}`);
        logToFile(`Redis 연결 오류: ${err}`);
    });

    redisClient.on('connect', () => {
        console.log('Redis 서버에 연결되었습니다.');
        logToFile('Redis 서버에 연결되었습니다.');
    });

    try {
        await redisClient.connect();
        console.log('Redis 연결 성공');
        
        // Redis 연결 테스트
        await redisClient.set('test', 'connected');
        const testValue = await redisClient.get('test');
        console.log('Redis 연결 테스트:', testValue);
    } catch (error) {
        console.error('Redis 연결 실패:', error);
        logToFile(`Redis 연결 실패: ${error.message}`);
    }
})();

// 로그 파일 설정
const logFile = fs.createWriteStream(path.join(__dirname, 'server.log'), { flags: 'a' });

// 로그 기록 함수
function logToFile(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    logFile.write(logMessage);
    console.log(message);
}

// 방 정보 저장을 위한 객체
const rooms = {};

// 연결된 클라이언트 수 추적
let connectedClients = 0;

// 방 참가자 관리를 위한 맵
const userRooms = new Map(); // 사용자 ID -> 방 코드

// 메모리 저장소 (임시 데이터용)
const memoryStore = {
    images: {},  // 방 코드별 이미지 저장: { roomCode: [이미지 데이터 배열] }
    drawings: {} // 방 코드별 그리기 데이터 저장: { roomCode: [그리기 데이터 배열] }
};

// 서버 시작 - 기존 코드 유지, 중복 제거
server.on('listening', () => {
    console.log(`서버가 ${PORT} 포트에서 실행 중입니다`);
    console.log(`http://localhost:${PORT}에서 접속 가능합니다`);
    
    // 서버 시작 시 초기화
    connectedClients = 0;
    
    // 모든 방 정보 초기화
    for (const roomCode in rooms) {
        rooms[roomCode].users = 0;
    }
    
    console.log('서버 상태 초기화 완료');
});

// 기존 server.listen() 호출은 유지하고, 새로 추가한 것은 제거
// server.listen(PORT, () => {
//     console.log(`서버가 ${PORT} 포트에서 실행 중입니다`);
//     console.log(`http://localhost:${PORT}에서 접속 가능합니다`);
    
//     // 서버 시작 시 초기화
//     connectedClients = 0;
    
//     // 모든 방 정보 초기화
//     for (const roomCode in rooms) {
//         rooms[roomCode].users = 0;
//     }
    
//     console.log('서버 상태 초기화 완료');
// });

// 랜덤 6자리 숫자 생성 함수
function generateRoomCode() {
    // 100000부터 999999까지의 랜덤 숫자 생성
    const min = 100000;
    const max = 999999;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 고유한 방 코드 생성 함수
async function createUniqueRoomCode() {
    let roomCode;
    let exists = true;
    
    // 존재하지 않는 방 코드가 나올 때까지 반복
    while (exists) {
        roomCode = generateRoomCode().toString();
        exists = await redisClient.exists(`room:${roomCode}`);
    }
    
    return roomCode;
}

// 방 생성 함수
async function createRoom(roomCode) {
    const roomKey = `room:${roomCode}`;
    const now = Date.now();
    const expiryTime = 2 * 60 * 60; // 2시간(초 단위)
    
    // 방 기본 정보 설정
    await redisClient.hSet(roomKey, 'createdAt', now);
    await redisClient.hSet(roomKey, 'lastActive', now);
    await redisClient.hSet(roomKey, 'users', 0);
    
    // 2시간 후 만료 설정
    await redisClient.expire(roomKey, expiryTime);
    
    logToFile(`새 방 생성: ${roomCode} (만료: 2시간)`);
    return roomCode;
}

// 방 정보 가져오기
async function getRoomInfo(roomCode) {
    const roomKey = `room:${roomCode}`;
    const exists = await redisClient.exists(roomKey);
    
    if (!exists) {
        return null;
    }
    
    const roomInfo = await redisClient.hGetAll(roomKey);
    
    // 숫자 타입 변환
    if (roomInfo.users) roomInfo.users = parseInt(roomInfo.users);
    if (roomInfo.createdAt) roomInfo.createdAt = parseInt(roomInfo.createdAt);
    if (roomInfo.lastActive) roomInfo.lastActive = parseInt(roomInfo.lastActive);
    
    return roomInfo;
}

// 방 사용자 수 업데이트
async function updateRoomUsers(roomCode, delta) {
    const roomKey = `room:${roomCode}`;
    const exists = await redisClient.exists(roomKey);
    
    if (!exists) {
        return false;
    }
    
    // 현재 사용자 수 가져오기
    let users = parseInt(await redisClient.hGet(roomKey, 'users') || '0');
    users += delta;
    
    // 사용자 수가 0보다 작아지지 않도록
    if (users < 0) users = 0;
    
    // 사용자 수 업데이트
    await redisClient.hSet(roomKey, 'users', users);
    
    // 마지막 활동 시간 업데이트
    await redisClient.hSet(roomKey, 'lastActive', Date.now());
    
    // 만료 시간 갱신 (사용자가 있는 동안은 만료되지 않도록)
    if (users > 0) {
        await redisClient.persist(roomKey);
    } else {
        // 사용자가 없으면 2시간 후 만료 설정
        await redisClient.expire(roomKey, 2 * 60 * 60);
    }
    
    return users;
}

// 그리기 데이터 저장
async function saveDrawingPoint(roomCode, point) {
    try {
        // 방 코드에 해당하는 그리기 데이터 배열이 없으면 초기화
        if (!memoryStore.drawings[roomCode]) {
            memoryStore.drawings[roomCode] = [];
        }
        
        // 그리기 데이터 저장
        memoryStore.drawings[roomCode].push(point);
        return true;
    } catch (error) {
        console.error(`그리기 데이터 저장 오류:`, error);
        logToFile(`그리기 데이터 저장 오류: ${error.message}`);
        return false;
    }
}

// 그리기 데이터 가져오기
async function getDrawingPoints(roomCode) {
    try {
        // 방 코드에 해당하는 그리기 데이터 배열이 없으면 빈 배열 반환
        if (!memoryStore.drawings[roomCode]) {
            return [];
        }
        
        return memoryStore.drawings[roomCode];
    } catch (error) {
        console.error(`그리기 데이터 로드 오류:`, error);
        logToFile(`그리기 데이터 로드 오류: ${error.message}`);
        return [];
    }
}

// 그리기 데이터 초기화
async function clearDrawingPoints(roomCode) {
    try {
        // 방 코드에 해당하는 그리기 데이터 배열 초기화
        memoryStore.drawings[roomCode] = [];
        return true;
    } catch (error) {
        console.error(`그리기 데이터 초기화 오류:`, error);
        logToFile(`그리기 데이터 초기화 오류: ${error.message}`);
        return false;
    }
}

// 이미지 데이터 저장 (Redis 대신 메모리에 저장)
async function saveImage(roomCode, imageData) {
    try {
        // 이미지 데이터가 너무 크면 로그에 전체 데이터를 기록하지 않음
        const logData = { ...imageData };
        if (logData.imageData && logData.imageData.length > 100) {
            logData.imageData = `${logData.imageData.substring(0, 100)}... (${logData.imageData.length} bytes)`;
        }
        
        console.log(`이미지 저장 시도: 방 ${roomCode}, 크기 ${imageData.width}x${imageData.height}`);
        
        // 방 코드에 해당하는 이미지 배열이 없으면 초기화
        if (!memoryStore.images[roomCode]) {
            memoryStore.images[roomCode] = [];
        }
        
        // 이미지 데이터 저장
        memoryStore.images[roomCode].push(imageData);
        
        const count = memoryStore.images[roomCode].length;
        console.log(`방 ${roomCode}의 이미지 개수: ${count}`);
        
        logToFile(`방 ${roomCode}에 이미지 저장 완료 (크기: ${imageData.width}x${imageData.height}, 총 이미지: ${count}개)`);
        return true;
    } catch (error) {
        console.error(`이미지 저장 오류:`, error);
        logToFile(`이미지 저장 오류: ${error.message}`);
        return false;
    }
}

// 이미지 데이터 가져오기 (Redis 대신 메모리에서 가져옴)
async function getImages(roomCode) {
    try {
        console.log(`이미지 데이터 로드 시도: 방 ${roomCode}`);
        
        // 방 코드에 해당하는 이미지 배열이 없으면 빈 배열 반환
        if (!memoryStore.images[roomCode]) {
            console.log(`방 ${roomCode}에 저장된 이미지가 없습니다.`);
            return [];
        }
        
        const images = memoryStore.images[roomCode];
        console.log(`방 ${roomCode}에서 로드한 이미지 개수: ${images.length}`);
        
        logToFile(`방 ${roomCode}에서 ${images.length}개의 이미지 데이터 로드 완료`);
        return images;
    } catch (error) {
        console.error(`이미지 데이터 로드 오류:`, error);
        logToFile(`이미지 데이터 로드 오류: ${error.message}`);
        return [];
    }
}

// 이미지 데이터 초기화 (Redis 대신 메모리에서 초기화)
async function clearImages(roomCode) {
    try {
        // 방 코드에 해당하는 이미지 배열 초기화
        memoryStore.images[roomCode] = [];
        logToFile(`방 ${roomCode}의 이미지 데이터 초기화 완료`);
        return true;
    } catch (error) {
        console.error(`이미지 데이터 초기화 오류:`, error);
        logToFile(`이미지 데이터 초기화 오류: ${error.message}`);
        return false;
    }
}

// Express 라우트 추가
// 새 방 생성 API
app.get('/api/create-room', async (req, res) => {
    try {
        const roomCode = await createUniqueRoomCode();
        await createRoom(roomCode);
        logToFile(`API 호출로 새 방 생성: ${roomCode}`);
        res.json({ roomCode });
    } catch (error) {
        logToFile(`방 생성 오류: ${error.message}`);
        res.status(500).json({ error: '방 생성 중 오류가 발생했습니다.' });
    }
});

// 방 존재 여부 확인 API
app.get('/api/check-room/:roomCode', async (req, res) => {
    try {
        const { roomCode } = req.params;
        const roomInfo = await getRoomInfo(roomCode);
        const exists = !!roomInfo;
        
        logToFile(`방 확인 요청: ${roomCode}, 존재: ${exists}`);
        res.json({ exists });
    } catch (error) {
        logToFile(`방 확인 오류: ${error.message}`);
        res.status(500).json({ error: '방 확인 중 오류가 발생했습니다.' });
    }
});

// 메인 페이지 라우트
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// 방 페이지 라우트
app.get('/room/:roomCode', async (req, res) => {
    try {
        const { roomCode } = req.params;
        
        // 방 정보 확인
        let roomInfo = await getRoomInfo(roomCode);
        
        // 방이 존재하지 않으면 생성
        if (!roomInfo) {
            await createRoom(roomCode);
            logToFile(`존재하지 않는 방에 접근 시도, 새로 생성: ${roomCode}`);
        }
        
        res.sendFile(path.join(__dirname, '../frontend/room.html'));
    } catch (error) {
        logToFile(`방 페이지 제공 오류: ${error.message}`);
        res.status(500).send('방 접속 중 오류가 발생했습니다.');
    }
});

// 헬스 체크 API
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: '서버가 정상적으로 실행 중입니다.' });
});

// Socket.IO 연결 처리
io.on('connection', (socket) => {
    let currentRoom = null;
    
    connectedClients++;
    logToFile(`사용자 연결됨: ${socket.id} (현재 연결: ${connectedClients}명)`);
    
    // 방 정보 업데이트 함수
    function updateRoomInfo(roomCode) {
        if (!rooms[roomCode]) return;
        
        // 실제 방에 연결된 소켓 수 계산
        const sockets = io.sockets.adapter.rooms.get(roomCode);
        const actualUsers = sockets ? sockets.size : 0;
        
        // 항상 실제 연결된 사용자 수로 업데이트
        if (rooms[roomCode].users !== actualUsers) {
            console.log(`방 ${roomCode}의 사용자 수 업데이트: ${rooms[roomCode].users} -> ${actualUsers}`);
            rooms[roomCode].users = actualUsers;
            
            // 마지막 활동 시간 업데이트
            rooms[roomCode].lastActive = Date.now();
            
            // 방의 모든 사용자에게 업데이트된 사용자 수 알림
            io.to(roomCode).emit('userCountUpdated', {
                users: actualUsers
            });
        }
        
        return rooms[roomCode];
    }
    
    // 방 입장 처리
    socket.on('joinRoom', async (roomCode) => {
        try {
            // 이전 방에서 나가기
            if (currentRoom) {
                socket.leave(currentRoom);
                // 이전 방에서 나간 후 실제 참가자 수 업데이트
                updateRoomInfo(currentRoom);
                logToFile(`사용자 ${socket.id}가 방 ${currentRoom}에서 나감`);
                
                // 방의 다른 사용자들에게 사용자 퇴장 알림
                socket.to(currentRoom).emit('userLeft', {
                    id: socket.id,
                    timestamp: Date.now()
                });
                
                // userRooms 맵에서 이전 방 정보 제거
                userRooms.delete(socket.id);
            }
            
            // 방 정보 확인
            let roomInfo = await getRoomInfo(roomCode);
            
            // 방이 존재하지 않으면 생성
            if (!roomInfo) {
                await createRoom(roomCode);
                roomInfo = await getRoomInfo(roomCode);
            }
            
            // 새 방에 입장
            socket.join(roomCode);
            currentRoom = roomCode;
            userRooms.set(socket.id, roomCode);
            
            // 방 정보 업데이트 (실제 참가자 수 확인)
            updateRoomInfo(roomCode);
            
            // 현재 방의 실제 참가자 수 가져오기
            const sockets = io.sockets.adapter.rooms.get(roomCode);
            const actualUsers = sockets ? sockets.size : 0;
            
            logToFile(`사용자 ${socket.id}가 방 ${roomCode}에 입장 (현재 인원: ${actualUsers}명)`);
            
            // 클라이언트에 연결 확인 메시지 전송
            socket.emit('roomJoined', { 
                roomCode,
                id: socket.id, 
                timestamp: Date.now(),
                users: actualUsers
            });
            
            // 방의 다른 사용자들에게 새 사용자 입장 알림
            socket.to(roomCode).emit('userJoined', {
                id: socket.id,
                users: actualUsers,
                timestamp: Date.now()
            });
            
            // 방의 그리기 데이터 전송
            const drawingPoints = await getDrawingPoints(roomCode);
            socket.emit('loadDrawing', drawingPoints);
            logToFile(`${drawingPoints.length}개의 그리기 데이터를 클라이언트에 전송했습니다.`);
            
            // 방의 이미지 데이터 전송
            console.log(`방 ${roomCode}의 이미지 데이터 로드 시도`);
            const images = await getImages(roomCode);
            console.log(`방 ${roomCode}에서 로드한 이미지 개수: ${images.length}`);
            
            if (images.length > 0) {
                socket.emit('loadImages', images);
                logToFile(`${images.length}개의 이미지 데이터를 클라이언트에 전송했습니다.`);
            } else {
                logToFile(`방 ${roomCode}에 저장된 이미지가 없습니다.`);
            }
        } catch (error) {
            console.error(`방 입장 오류:`, error);
            logToFile(`방 입장 오류: ${error.message}`);
            socket.emit('error', { message: '방 입장 중 오류가 발생했습니다.' });
        }
    });
    
    // 그리기 데이터 요청 처리
    socket.on('requestDrawingData', async () => {
        try {
            if (!currentRoom) return;
            
            const drawingPoints = await getDrawingPoints(currentRoom);
            socket.emit('loadDrawing', drawingPoints);
            logToFile(`요청에 따라 ${drawingPoints.length}개의 그리기 데이터를 클라이언트에 전송했습니다.`);
        } catch (error) {
            logToFile(`그리기 데이터 요청 오류: ${error.message}`);
            socket.emit('error', { message: '그리기 데이터 로드 중 오류가 발생했습니다.' });
        }
    });
    
    // 이미지 데이터 요청 처리
    socket.on('requestImageData', async () => {
        try {
            if (!currentRoom) {
                socket.emit('error', { message: '방에 입장하지 않은 상태입니다. 페이지를 새로고침해 주세요.' });
                return;
            }
            
            console.log(`이미지 데이터 요청: 방 ${currentRoom}, 사용자 ${socket.id}`);
            
            const images = await getImages(currentRoom);
            console.log(`요청에 의해 로드한 이미지 개수: ${images.length}`);
            
            socket.emit('loadImages', images);
            logToFile(`요청에 따라 ${images.length}개의 이미지 데이터를 클라이언트에 전송했습니다.`);
        } catch (error) {
            console.error(`이미지 데이터 요청 오류:`, error);
            logToFile(`이미지 데이터 요청 오류: ${error.message}`);
            socket.emit('error', { message: '이미지 데이터 로드 중 오류가 발생했습니다.' });
        }
    });
    
    // 그리기 이벤트 수신 및 브로드캐스트
    socket.on('draw', async (data) => {
        try {
            if (!currentRoom) return;
            
            // Redis에 그리기 데이터 저장
            await saveDrawingPoint(currentRoom, data);
            
            // 같은 방의 다른 사용자에게 그리기 데이터 브로드캐스트
            socket.to(currentRoom).emit('draw', data);
        } catch (error) {
            logToFile(`그리기 데이터 저장 오류: ${error.message}`);
        }
    });

    // 이미지 청크 처리
    socket.on('imageChunk', async (data) => {
        try {
            if (!currentRoom) {
                socket.emit('error', { message: '방에 입장하지 않은 상태입니다. 페이지를 새로고침해 주세요.' });
                return;
            }
            
            const { chunkIndex, totalChunks } = data;
            
            // 첫 번째 청크일 때만 로그 기록
            if (chunkIndex === 0) {
                console.log(`이미지 청크 수신 시작: 방 ${currentRoom}, 사용자 ${socket.id}, 총 ${totalChunks}개 청크`);
                logToFile(`방 ${currentRoom}에서 이미지 청크 수신 시작 (사용자: ${socket.id}, 총 청크: ${totalChunks}개)`);
            }
            
            // 마지막 청크일 때 로그 기록
            if (chunkIndex === totalChunks - 1) {
                console.log(`이미지 청크 수신 완료: 방 ${currentRoom}, 사용자 ${socket.id}`);
                logToFile(`방 ${currentRoom}에서 이미지 청크 수신 완료 (사용자: ${socket.id})`);
            }
            
            // 같은 방의 다른 사용자에게 청크 전달 (자신 제외)
            socket.to(currentRoom).emit('imageChunk', data);
            
        } catch (error) {
            console.error(`이미지 청크 처리 오류:`, error);
            logToFile(`이미지 청크 처리 오류: ${error.message}`);
            socket.emit('error', { message: '이미지 청크 처리 중 오류가 발생했습니다.' });
        }
    });

    // 이미지 붙여넣기 이벤트 수신 및 브로드캐스트
    socket.on('pasteImage', async (data) => {
        try {
            if (!currentRoom) {
                socket.emit('error', { message: '방에 입장하지 않은 상태입니다. 페이지를 새로고침해 주세요.' });
                return;
            }
            
            console.log(`이미지 붙여넣기 요청 수신: 방 ${currentRoom}, 사용자 ${socket.id}`);
            logToFile(`방 ${currentRoom}에서 이미지 붙여넣기 요청 수신 (사용자: ${socket.id})`);
            
            // 사용자 ID 확인
            if (!data.userId) {
                data.userId = socket.id;
            }
            
            // 타임스탬프 추가
            if (!data.timestamp) {
                data.timestamp = Date.now();
            }
            
            // 이미지 데이터 크기 확인
            const imageSize = data.imageData ? data.imageData.length : 0;
            console.log(`이미지 데이터 크기: ${Math.round(imageSize / 1024)}KB`);
            
            // 이미지 데이터가 너무 크면 로그에 전체 데이터를 기록하지 않음
            const logData = { ...data };
            if (logData.imageData && logData.imageData.length > 100) {
                logData.imageData = `${logData.imageData.substring(0, 100)}... (${logData.imageData.length} bytes)`;
            }
            
            // 메모리에 이미지 데이터 저장
            const saved = await saveImage(currentRoom, data);
            
            if (saved) {
                console.log(`이미지 저장 성공: 방 ${currentRoom}`);
                
                // 같은 방의 다른 사용자에게 이미지 데이터 브로드캐스트 (자신 제외)
                socket.to(currentRoom).emit('pasteImage', data);
                logToFile(`방 ${currentRoom}에 pasteImage 이벤트 브로드캐스트 완료 (이미지 크기: ${data.width}x${data.height})`);
            } else {
                console.error(`이미지 저장 실패: 방 ${currentRoom}`);
                socket.emit('error', { message: '이미지 저장 중 오류가 발생했습니다.' });
            }
        } catch (error) {
            console.error(`이미지 데이터 처리 오류:`, error);
            logToFile(`이미지 데이터 처리 오류: ${error.message}`);
            socket.emit('error', { message: '이미지 처리 중 오류가 발생했습니다.' });
        }
    });

    // 캔버스 지우기 이벤트 수신 및 브로드캐스트
    socket.on('clearCanvas', async () => {
        try {
            if (!currentRoom) return;
            
            logToFile(`방 ${currentRoom}에서 캔버스 지우기 요청 수신`);
            
            // Redis에서 그리기 및 이미지 데이터 삭제
            await clearDrawingPoints(currentRoom);
            await clearImages(currentRoom);
            
            // 같은 방의 다른 사용자에게 캔버스 지우기 이벤트 브로드캐스트
            socket.to(currentRoom).emit('clearCanvas');
            logToFile(`방 ${currentRoom}에 clearCanvas 이벤트 브로드캐스트 완료`);
        } catch (error) {
            logToFile(`캔버스 지우기 오류: ${error.message}`);
        }
    });

    // 연결 상태 확인 핑
    socket.on('ping', (callback) => {
        if (typeof callback === 'function') {
            // 현재 방의 실제 참가자 수 가져오기
            const roomCode = userRooms.get(socket.id);
            let roomUsers = 0;
            
            if (roomCode) {
                const sockets = io.sockets.adapter.rooms.get(roomCode);
                roomUsers = sockets ? sockets.size : 0;
                
                // 방 정보 업데이트
                if (rooms[roomCode] && rooms[roomCode].users !== roomUsers) {
                    rooms[roomCode].users = roomUsers;
                }
            }
            
            callback({
                id: socket.id,
                connectedClients: connectedClients,
                roomUsers: roomUsers
            });
        } else {
            // 현재 방의 실제 참가자 수 가져오기
            const roomCode = userRooms.get(socket.id);
            let roomUsers = 0;
            
            if (roomCode) {
                const sockets = io.sockets.adapter.rooms.get(roomCode);
                roomUsers = sockets ? sockets.size : 0;
                
                // 방 정보 업데이트
                if (rooms[roomCode] && rooms[roomCode].users !== roomUsers) {
                    rooms[roomCode].users = roomUsers;
                }
            }
            
            socket.emit('pong', {
                id: socket.id,
                connectedClients: connectedClients,
                roomUsers: roomUsers
            });
        }
    });

    // 방 정보 요청 처리
    socket.on('requestRoomInfo', () => {
        const roomCode = userRooms.get(socket.id);
        if (roomCode) {
            // 현재 방의 실제 참가자 수 가져오기
            const sockets = io.sockets.adapter.rooms.get(roomCode);
            const actualUsers = sockets ? sockets.size : 0;
            
            // 방 정보 업데이트
            if (rooms[roomCode]) {
                rooms[roomCode].users = actualUsers;
            }
            
            socket.emit('roomInfo', {
                roomCode: roomCode,
                users: actualUsers,
                createdAt: rooms[roomCode] ? rooms[roomCode].createdAt : Date.now()
            });
        }
    });

    // 서버 상태 요청 처리
    socket.on('requestServerStatus', () => {
        socket.emit('serverStatus', {
            connectedClients: connectedClients,
            totalRooms: Object.keys(rooms).length
        });
    });

    // 오류 처리
    socket.on('error', (error) => {
        logToFile(`소켓 오류: ${error}`);
    });

    // 연결 종료 처리
    socket.on('disconnect', async (reason) => {
        connectedClients--;
        
        try {
            // 방에서 나가기 처리
            if (currentRoom) {
                // userRooms 맵에서 사용자 정보 제거
                userRooms.delete(socket.id);
                
                // 방 정보 업데이트 (실제 참가자 수 확인)
                // 참고: disconnect 이벤트는 이미 소켓이 방에서 나간 후에 발생하므로
                // 실제 참가자 수는 이미 감소된 상태
                updateRoomInfo(currentRoom);
                
                // 현재 방의 실제 참가자 수 가져오기
                const sockets = io.sockets.adapter.rooms.get(currentRoom);
                const actualUsers = sockets ? sockets.size : 0;
                
                logToFile(`사용자 ${socket.id}가 방 ${currentRoom}에서 연결 끊김 (이유: ${reason}) (현재 인원: ${actualUsers}명)`);
                
                // 방의 다른 사용자들에게 사용자 퇴장 알림
                socket.to(currentRoom).emit('userLeft', {
                    id: socket.id,
                    users: actualUsers
                });
            } else {
                logToFile(`사용자 연결 끊김: ${socket.id} (이유: ${reason}) (현재 연결: ${connectedClients}명)`);
            }
        } catch (error) {
            logToFile(`연결 종료 처리 오류: ${error.message}`);
        }
    });

    // 연결 설정 시 초기화 메시지 전송
    socket.emit('connectionEstablished', {
        message: '서버에 연결되었습니다.',
        socketId: socket.id,
        timestamp: new Date().toISOString()
    });
});

// 메모리 사용량 모니터링 및 관리
setInterval(() => {
    // 메모리 사용량 확인
    const memoryUsage = process.memoryUsage();
    logToFile(`메모리 사용량: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`);
}, 300000); // 5분마다 실행

// Redis 키 만료 모니터링 설정
async function setupRedisExpireMonitoring() {
    try {
        // Redis 키 만료 이벤트 구독 설정
        const subscriber = redisClient.duplicate();
        await subscriber.connect();
        
        // 키 만료 이벤트 구독
        await subscriber.configSet('notify-keyspace-events', 'Ex');
        await subscriber.subscribe('__keyevent@0__:expired', (message) => {
            logToFile(`Redis 키 만료됨: ${message}`);
            
            // 방 관련 키가 만료된 경우 처리
            if (message.startsWith('room:')) {
                const parts = message.split(':');
                if (parts.length >= 2) {
                    const roomCode = parts[1];
                    
                    // 메모리에서 방 정보 삭제
                    if (rooms[roomCode]) {
                        delete rooms[roomCode];
                        logToFile(`만료된 방 정보 삭제: ${roomCode}`);
                    }
                }
            }
        });
        
        logToFile('Redis 키 만료 모니터링 설정 완료');
    } catch (error) {
        logToFile(`Redis 키 만료 모니터링 설정 오류: ${error.message}`);
    }
}

// 서버 상태 모니터링 및 연결 정리
setInterval(async () => {
    console.log(`현재 연결된 클라이언트: ${connectedClients}명`);
    console.log(`활성화된 방 수: ${Object.keys(rooms).length}개`);
    
    // 방 참가자 수 검증 및 수정
    for (const [roomCode, room] of Object.entries(rooms)) {
        // 실제 방에 연결된 소켓 수 계산
        const sockets = io.sockets.adapter.rooms.get(roomCode);
        const actualUsers = sockets ? sockets.size : 0;
        
        // 항상 실제 연결된 사용자 수로 업데이트
        if (room.users !== actualUsers) {
            console.log(`방 ${roomCode}의 사용자 수 업데이트: ${room.users} -> ${actualUsers}`);
            room.users = actualUsers;
            
            // Redis에도 업데이트
            try {
                const roomKey = `room:${roomCode}`;
                const exists = await redisClient.exists(roomKey);
                
                if (exists) {
                    await redisClient.hSet(roomKey, 'users', actualUsers);
                    await redisClient.hSet(roomKey, 'lastActive', Date.now());
                    
                    // 사용자가 있으면 만료 시간 제거, 없으면 2시간 설정
                    if (actualUsers > 0) {
                        await redisClient.persist(roomKey);
                    } else {
                        await redisClient.expire(roomKey, 2 * 60 * 60);
                    }
                }
            } catch (error) {
                logToFile(`Redis 방 정보 업데이트 오류: ${error.message}`);
            }
            
            // 방의 모든 사용자에게 업데이트된 사용자 수 알림
            io.to(roomCode).emit('userCountUpdated', {
                users: actualUsers
            });
        }
    }
    
    // 빈 방 정리 (선택 사항)
    for (const [roomCode, room] of Object.entries(rooms)) {
        if (room.users <= 0) {
            // 마지막 활동 시간이 1시간 이상 지난 빈 방 삭제
            const inactiveTime = Date.now() - room.lastActive;
            if (inactiveTime > 60 * 60 * 1000) { // 1시간
                console.log(`비활성 방 삭제: ${roomCode} (마지막 활동: ${new Date(room.lastActive).toISOString()})`);
                
                try {
                    // Redis에서 방 관련 데이터 삭제
                    const roomKey = `room:${roomCode}`;
                    const pointsKey = `room:${roomCode}:points`;
                    const imagesKey = `room:${roomCode}:images`;
                    
                    await redisClient.del(roomKey);
                    await redisClient.del(pointsKey);
                    await redisClient.del(imagesKey);
                    
                    // 메모리에서 방 정보 삭제
                    delete rooms[roomCode];
                    
                    logToFile(`비활성 방 데이터 삭제 완료: ${roomCode}`);
                } catch (error) {
                    logToFile(`방 데이터 삭제 오류: ${error.message}`);
                }
            }
        }
    }
}, 60000); // 1분마다 실행

// 서버 종료 시 정리
process.on('SIGINT', async () => {
    logToFile('서버 종료 중...');
    
    try {
        await redisClient.quit();
        logToFile('Redis 연결 종료됨');
    } catch (error) {
        logToFile(`Redis 연결 종료 오류: ${error.message}`);
    }
    
    logFile.end();
    process.exit(0);
});

// 서버 시작
server.listen(PORT, () => {
    console.log(`서버가 ${PORT} 포트에서 실행 중입니다`);
    console.log(`http://localhost:${PORT}에서 접속 가능합니다`);
    
    // 서버 시작 시 초기화
    connectedClients = 0;
    
    // 모든 방 정보 초기화
    for (const roomCode in rooms) {
        rooms[roomCode].users = 0;
    }
    
    console.log('서버 상태 초기화 완료');
});
