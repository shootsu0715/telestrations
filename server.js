const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e6,
  pingInterval: 10000,
  pingTimeout: 30000
});

let htmlContent = '';
[path.join(process.cwd(),'public','index.html'), path.resolve(__dirname,'public','index.html'),
 path.join(process.cwd(),'index.html'), path.resolve(__dirname,'index.html')].forEach(p => {
  if (!htmlContent) try { htmlContent = fs.readFileSync(p, 'utf8'); console.log('✅ HTML:', p); } catch(e){}
});
// 静的ファイルの配信（public/ 以下の画像等）
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => { htmlContent ? res.type('html').send(htmlContent) : res.status(500).send('index.html not found'); });

const rooms = {};
const sessions = {};

function genCode() {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code='';
  for(let i=0;i<4;i++) code+=c[Math.floor(Math.random()*c.length)];
  return rooms[code]?genCode():code;
}
function broadcast(room, ev, fn) {
  room.players.forEach((p,i) => { if(p.socketId) io.to(p.socketId).emit(ev, typeof fn==='function'?fn(p,i):fn); });
}
function onlineCount(room) { return room.players.filter(p=>p.online).length; }
function isHostP(room, p) { return p.sessionId===room.hostSessionId; }
function getChainForPlayer(N, pIdx, round) { return ((pIdx-1-round)%N+N)%N; }

function buildChains(room) {
  const N=room.players.length;
  room.chains=[];
  room.players.forEach((p,i) => {
    room.chains.push({ topicPlayerIdx:i, topicPlayerName:p.name, entries:[{type:'topic',content:room.topics[i],playerName:p.name}] });
  });
  room.currentRound=0;
  room.totalRounds=N-1;
  room.roundSubmissions={};
}

function startRound(room) {
  const N=room.players.length, round=room.currentRound, isDraw=round%2===0;
  room.roundSubmissions={};
  room.players.forEach((p,pIdx) => {
    if(!p.socketId) return;
    const cIdx=getChainForPlayer(N,pIdx,round);
    const last=room.chains[cIdx].entries[room.chains[cIdx].entries.length-1];
    io.to(p.socketId).emit('yourTurn',{type:isDraw?'draw':'guess',prompt:last.content,promptType:last.type,roundNumber:round+1,totalRounds:room.totalRounds});
  });
}

function handleSubmission(room, sessionId, type, content) {
  const N=room.players.length, round=room.currentRound;
  const pIdx=room.players.findIndex(p=>p.sessionId===sessionId);
  if(pIdx===-1||room.roundSubmissions[sessionId]) return;
  const cIdx=getChainForPlayer(N,pIdx,round);
  room.chains[cIdx].entries.push({type,content,playerName:room.players[pIdx].name});
  room.roundSubmissions[sessionId]=true;
  const sub=Object.keys(room.roundSubmissions).length;
  const sid=room.players[pIdx].socketId;
  if(sid) io.to(sid).emit('waitingForOthers',{submitted:sub,total:N});
  broadcast(room,'roundProgress',{submitted:sub,total:N});
  if(sub>=N) {
    room.currentRound++;
    if(room.currentRound>=room.totalRounds) {
      room.phase='reveal'; room.revealChainIdx=0; room.revealStepIdx=0;
      broadcast(room,'allChainsComplete',p=>({totalChains:room.chains.length,isHost:isHostP(room,p)}));
    } else startRound(room);
  }
}

function restoreState(room, player, pIdx) {
  const sid=player.socketId; if(!sid) return;
  if(room.phase==='lobby') { broadcastLobby(room); return; }
  if(room.phase==='topics') {
    if(room.topics[pIdx]!==undefined) {
      io.to(sid).emit('topicSubmitted');
      io.to(sid).emit('topicProgress',{submitted:room.players.filter((_,i)=>room.topics[i]!==undefined).length,total:room.players.length});
    } else io.to(sid).emit('enterTopic',{isHost:isHostP(room,player)});
    return;
  }
  if(room.phase==='playing') {
    if(room.roundSubmissions[player.sessionId]) {
      io.to(sid).emit('waitingForOthers',{submitted:Object.keys(room.roundSubmissions).length,total:room.players.length});
    } else {
      const N=room.players.length, round=room.currentRound, isDraw=round%2===0;
      const cIdx=getChainForPlayer(N,pIdx,round);
      const last=room.chains[cIdx].entries[room.chains[cIdx].entries.length-1];
      io.to(sid).emit('yourTurn',{type:isDraw?'draw':'guess',prompt:last.content,promptType:last.type,roundNumber:round+1,totalRounds:room.totalRounds});
    }
    return;
  }
  if(room.phase==='reveal') {
    io.to(sid).emit('allChainsComplete',{totalChains:room.chains.length,isHost:isHostP(room,player)});
  }
}

function broadcastLobby(room) {
  broadcast(room,'roomState',p=>({
    code:room.code,
    players:room.players.map(pl=>({name:pl.name,online:pl.online})),
    hostName:room.players[0]?.name,
    phase:room.phase,
    isHost:isHostP(room,p)
  }));
}

function findByHost(socket) { return Object.values(rooms).find(r=>{const p=r.players.find(pl=>pl.socketId===socket.id);return p&&isHostP(r,p);}); }
function findBySocket(sid) { return Object.values(rooms).find(r=>r.players.some(p=>p.socketId===sid)); }

io.on('connection', socket => {
  console.log('Connected:', socket.id);

  socket.on('reconnectSession', (sessionId, cb) => {
    const s=sessions[sessionId]; if(!s) return cb({success:false});
    const room=rooms[s.roomCode]; if(!room) return cb({success:false});
    const pIdx=room.players.findIndex(p=>p.sessionId===sessionId);
    if(pIdx===-1) return cb({success:false});
    room.players[pIdx].socketId=socket.id;
    room.players[pIdx].online=true;
    socket.join(room.code);
    console.log('♻️ 再接続:',s.name);
    cb({success:true,code:room.code,name:s.name,phase:room.phase});
    broadcast(room,'playerReconnected',{name:s.name,onlineCount:onlineCount(room)});
    restoreState(room,room.players[pIdx],pIdx);
  });

  socket.on('createRoom', (data, cb) => {
    const {name,sessionId}=data, code=genCode();
    rooms[code]={code,hostSessionId:sessionId,players:[{socketId:socket.id,sessionId,name,online:true}],
      phase:'lobby',topics:{},chains:[],currentRound:0,totalRounds:0,roundSubmissions:{},revealChainIdx:0,revealStepIdx:0};
    sessions[sessionId]={roomCode:code,name};
    socket.join(code); cb({success:true,code}); broadcastLobby(rooms[code]);
  });

  socket.on('joinRoom', (data, cb) => {
    const {name,code,sessionId}=data;
    const room=rooms[code?.toUpperCase()];
    if(!room) return cb({success:false,error:'ルームが見つかりません'});
    if(room.phase!=='lobby') return cb({success:false,error:'ゲーム中です'});
    if(room.players.length>=8) return cb({success:false,error:'満員です（最大8人）'});
    if(room.players.some(p=>p.name===name)) return cb({success:false,error:'その名前は使われています'});
    room.players.push({socketId:socket.id,sessionId,name,online:true});
    sessions[sessionId]={roomCode:room.code,name};
    socket.join(room.code); cb({success:true,code:room.code}); broadcastLobby(room);
  });

  socket.on('startGame', cb => {
    const room=findByHost(socket);
    if(!room) return cb?.({success:false,error:'ルームが見つかりません'});
    if(room.players.length<3) return cb?.({success:false,error:'3人以上必要です'});
    room.phase='topics'; room.topics={};
    cb?.({success:true});
    broadcast(room,'enterTopic',p=>({isHost:isHostP(room,p)}));
  });

  socket.on('submitTopic', topic => {
    const room=findBySocket(socket.id); if(!room||room.phase!=='topics') return;
    const pIdx=room.players.findIndex(p=>p.socketId===socket.id); if(pIdx===-1) return;
    room.topics[pIdx]=topic.trim();
    io.to(socket.id).emit('topicSubmitted');
    const sub=room.players.filter((_,i)=>room.topics[i]!==undefined).length;
    broadcast(room,'topicProgress',{submitted:sub,total:room.players.length});
    if(sub>=room.players.length){ room.phase='playing'; buildChains(room); startRound(room); }
  });

  socket.on('submitDrawing', data => {
    const room=findBySocket(socket.id); if(!room||room.phase!=='playing') return;
    const p=room.players.find(pl=>pl.socketId===socket.id); if(!p) return;
    handleSubmission(room,p.sessionId,'drawing',data);
  });

  socket.on('submitGuess', guess => {
    const room=findBySocket(socket.id); if(!room||room.phase!=='playing') return;
    const p=room.players.find(pl=>pl.socketId===socket.id); if(!p) return;
    handleSubmission(room,p.sessionId,'guess',guess.trim());
  });

  socket.on('startReveal', () => {
    const room=findByHost(socket); if(!room||room.phase!=='reveal') return;
    room.revealChainIdx=0; room.revealStepIdx=0;
    const chain=room.chains[0];
    broadcast(room,'startChainReveal',p=>({
      chainIdx:0, totalChains:room.chains.length, topicPlayerName:chain.topicPlayerName,
      totalSteps:chain.entries.length, firstEntry:chain.entries[0], isHost:isHostP(room,p)
    }));
  });

  socket.on('nextRevealStep', () => {
    const room=findByHost(socket); if(!room||room.phase!=='reveal') return;
    const chain=room.chains[room.revealChainIdx]; if(!chain) return;
    room.revealStepIdx++;
    if(room.revealStepIdx>=chain.entries.length) {
      broadcast(room,'chainComplete',p=>({chainIdx:room.revealChainIdx,chain,hasMoreChains:room.revealChainIdx<room.chains.length-1,isHost:isHostP(room,p)}));
      return;
    }
    const entry=chain.entries[room.revealStepIdx];
    broadcast(room,'revealStep',p=>({
      chainIdx:room.revealChainIdx, stepIdx:room.revealStepIdx, totalSteps:chain.entries.length,
      entry, isLast:room.revealStepIdx>=chain.entries.length-1,
      topicPlayerName:chain.topicPlayerName, originalTopic:chain.entries[0].content, isHost:isHostP(room,p)
    }));
  });

  socket.on('nextChain', () => {
    const room=findByHost(socket); if(!room||room.phase!=='reveal') return;
    room.revealChainIdx++;
    if(room.revealChainIdx>=room.chains.length) {
      broadcast(room,'allRevealed',p=>({chains:room.chains,isHost:isHostP(room,p)}));
      return;
    }
    room.revealStepIdx=0;
    const chain=room.chains[room.revealChainIdx];
    broadcast(room,'startChainReveal',p=>({
      chainIdx:room.revealChainIdx, totalChains:room.chains.length, topicPlayerName:chain.topicPlayerName,
      totalSteps:chain.entries.length, firstEntry:chain.entries[0], isHost:isHostP(room,p)
    }));
  });

  socket.on('newGame', () => {
    const room=findByHost(socket); if(!room) return;
    room.phase='topics'; room.topics={}; room.chains=[]; room.currentRound=0; room.roundSubmissions={}; room.revealChainIdx=0; room.revealStepIdx=0;
    broadcast(room,'enterTopic',p=>({isHost:isHostP(room,p)}));
  });

  socket.on('backToLobby', () => {
    const room=findByHost(socket); if(!room) return;
    room.phase='lobby'; room.topics={}; room.chains=[];
    broadcastLobby(room);
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    for(const code in rooms) {
      const room=rooms[code];
      const pIdx=room.players.findIndex(p=>p.socketId===socket.id);
      if(pIdx===-1) continue;
      room.players[pIdx].socketId=null;
      room.players[pIdx].online=false;
      console.log('⚠️ オフライン:', room.players[pIdx].name);
      broadcast(room,'playerWentOffline',{name:room.players[pIdx].name,onlineCount:onlineCount(room)});
      if(room.phase==='lobby') {
        const sessionId=room.players[pIdx].sessionId;
        setTimeout(()=>{
          const p=room.players.find(pl=>pl.sessionId===sessionId);
          if(p&&!p.online){
            room.players=room.players.filter(pl=>pl.sessionId!==sessionId);
            delete sessions[sessionId];
            if(room.players.length===0) delete rooms[code];
            else { if(room.hostSessionId===sessionId) room.hostSessionId=room.players[0].sessionId; broadcastLobby(room); }
          }
        },60000);
      }
      break;
    }
  });
});

const PORT=process.env.PORT||3001;
function getIPs(){const ips=[],f=os.networkInterfaces();for(const n of Object.keys(f))for(const i of f[n])if(i.family==='IPv4'&&!i.internal)ips.push(i.address);return ips;}
server.listen(PORT,'0.0.0.0',()=>{
  const ips=getIPs();
  console.log('\n🎨 ==========================================');
  console.log('   The画伯 v2.1 起動！');
  console.log('==========================================\n');
  console.log('   🏠 ローカル:  http://localhost:'+PORT);
  ips.forEach(ip=>console.log('   📱 ネットワーク: http://'+ip+':'+PORT));
  console.log('\n   同じネットワークからアクセスできます');
  console.log('==========================================\n');
});
