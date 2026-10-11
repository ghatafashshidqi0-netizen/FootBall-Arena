
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const rooms = new Map();

const FIELD = { w: 1000, h: 600 };
const PLAYER_R = 17;
const BALL_R = 10;
const GOAL_TOP = 220;
const GOAL_BOTTOM = 380;
const MATCH_TIME = 180;

app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.json({ status: "ok", rooms: rooms.size });
});

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from(
      { length: 5 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function newBall() {
  return { x: 500, y: 300, vx: 0, vy: 0 };
}

function publicRoom(room) {
  return {
    code: room.code,
    host: room.host,
    status: room.status,
    score: room.score,
    time: room.time,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      ready: p.ready,
      x: p.x,
      y: p.y,
      facing: p.facing
    }))
  };
}

function emitRoom(room) {
  io.to(room.code).emit("roomUpdate", publicRoom(room));
}

function resetPositions(room) {
  let red = 0;
  let blue = 0;

  for (const p of room.players.values()) {
    if (p.team === "red") {
      p.x = 180 + red * 35;
      p.y = 220 + (red % 3) * 80;
      red++;
    } else {
      p.x = 820 - blue * 35;
      p.y = 220 + (blue % 3) * 80;
      blue++;
    }
    p.facing = p.team === "red" ? 1 : -1;
    p.vx = 0;
    p.vy = 0;
    p.cooldown = 0;
  }

  room.ball = newBall();
}

function stopMatch(room) {
  room.status = "finished";
  room.time = 0;
  room.inputs.clear();
  io.to(room.code).emit("matchEnd", {
    score: room.score,
    players: publicRoom(room).players
  });
  emitRoom(room);
}

function startMatch(room) {
  if (room.players.size < 2 || room.status === "playing") return;

  room.status = "playing";
  room.score = { red: 0, blue: 0 };
  room.time = MATCH_TIME;
  room.lastTick = Date.now();
  room.inputs.clear();

  resetPositions(room);
  io.to(room.code).emit("matchStarted", {
    state: publicRoom(room),
    ball: room.ball
  });
  emitRoom(room);
}

function goal(room, team) {
  if (room.status !== "playing") return;

  room.score[team]++;
  io.to(room.code).emit("goal", {
    team,
    score: room.score
  });

  resetPositions(room);
  room.goalPause = Date.now() + 1800;
}

function removePlayer(socket) {
  const code = socket.data.room;
  if (!code) return;

  const room = rooms.get(code);
  socket.data.room = null;
  if (!room) return;

  room.players.delete(socket.id);
  room.inputs.delete(socket.id);

  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }

  if (room.host === socket.id) {
    room.host = room.players.keys().next().value;
  }

  if (room.status === "playing" && room.players.size < 2) {
    room.status = "waiting";
    room.inputs.clear();
    room.time = MATCH_TIME;
    resetPositions(room);
    io.to(room.code).emit("systemMessage", "Pertandingan dihentikan karena pemain kurang.");
  }

  emitRoom(room);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name } = {}, callback = () => {}) => {
    if (socket.data.room) removePlayer(socket);

    const code = makeCode();
    const player = {
      id: socket.id,
      name: String(name || "Player").trim().slice(0, 16) || "Player",
      team: "red",
      ready: false,
      x: 180,
      y: 300,
      vx: 0,
      vy: 0,
      facing: 1,
      cooldown: 0
    };

    const room = {
      code,
      host: socket.id,
      players: new Map([[socket.id, player]]),
      inputs: new Map(),
      ball: newBall(),
      score: { red: 0, blue: 0 },
      status: "waiting",
      time: MATCH_TIME,
      lastTick: Date.now(),
      goalPause: 0
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.room = code;

    callback({ ok: true, code, id: socket.id });
    emitRoom(room);
  });

  socket.on("joinRoom", ({ code, name } = {}, callback = () => {}) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return callback({ ok: false, error: "Room tidak ditemukan." });
    if (room.status === "playing") return callback({ ok: false, error: "Pertandingan sudah dimulai." });
    if (room.players.size >= 8) return callback({ ok: false, error: "Room penuh (maksimal 8 pemain)." });

    if (socket.data.room) removePlayer(socket);

    const redCount = [...room.players.values()].filter(p => p.team === "red").length;
    const blueCount = [...room.players.values()].filter(p => p.team === "blue").length;
    const team = redCount <= blueCount ? "red" : "blue";

    room.players.set(socket.id, {
      id: socket.id,
      name: String(name || "Player").trim().slice(0, 16) || "Player",
      team,
      ready: false,
      x: team === "red" ? 180 : 820,
      y: 300,
      vx: 0,
      vy: 0,
      facing: team === "red" ? 1 : -1,
      cooldown: 0
    });

    socket.join(code);
    socket.data.room = code;
    callback({ ok: true, code, id: socket.id });
    emitRoom(room);
  });

  socket.on("chooseTeam", team => {
    const room = rooms.get(socket.data.room);
    const p = room?.players.get(socket.id);
    if (!p || room.status === "playing") return;
    if (team !== "red" && team !== "blue") return;

    const count = [...room.players.values()].filter(
      q => q.team === team && q.id !== p.id
    ).length;
    if (count >= 4) return;

    p.team = team;
    p.ready = false;
    emitRoom(room);
  });

  socket.on("setReady", ready => {
    const room = rooms.get(socket.data.room);
    const p = room?.players.get(socket.id);
    if (!p || room.status === "playing") return;

    p.ready = !!ready;
    emitRoom(room);
  });

  socket.on("startMatch", () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.host !== socket.id) return;

    const red = [...room.players.values()].filter(p => p.team === "red").length;
    const blue = [...room.players.values()].filter(p => p.team === "blue").length;

    if (room.players.size < 2 || red === 0 || blue === 0) {
      socket.emit("systemMessage", "Butuh minimal 2 pemain dan kedua tim harus terisi.");
      return;
    }

    startMatch(room);
  });

  socket.on("input", data => {
    const room = rooms.get(socket.data.room);
    if (!room || room.status !== "playing") return;
    if (!room.players.has(socket.id) || !data) return;

    room.inputs.set(socket.id, {
      x: Math.max(-1, Math.min(1, Number(data.x) || 0)),
      y: Math.max(-1, Math.min(1, Number(data.y) || 0)),
      sprint: !!data.sprint,
      shoot: !!data.shoot,
      pass: !!data.pass,
      tackle: !!data.tackle,
      seq: Number(data.seq) || 0
    });
  });

  socket.on("leaveRoom", () => removePlayer(socket));
  socket.on("disconnect", () => removePlayer(socket));
});

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function simulate(room, dt) {
  const now = Date.now();

  if (room.status !== "playing") return;

  room.time -= dt;
  if (room.time <= 0) {
    stopMatch(room);
    return;
  }

  if (now < room.goalPause) return;

  const players = [...room.players.values()];
  const ball = room.ball;

  for (const p of players) {
    const input = room.inputs.get(p.id) || {};
    const dx = input.x || 0;
    const dy = input.y || 0;
    const length = Math.hypot(dx, dy) || 1;
    const speed = input.sprint ? 255 : 190;

    p.vx = dx / length * speed;
    p.vy = dy / length * speed;

    if (Math.abs(dx) > 0.1) p.facing = Math.sign(dx);

    p.x = clamp(p.x + p.vx * dt, PLAYER_R, FIELD.w - PLAYER_R);
    p.y = clamp(p.y + p.vy * dt, PLAYER_R, FIELD.h - PLAYER_R);

    p.cooldown = Math.max(0, p.cooldown - dt);

    // Dribble and ball control
    const d = dist(p, ball);
    if (d < PLAYER_R + BALL_R + 9) {
      const nx = (ball.x - p.x) / (d || 1);
      const ny = (ball.y - p.y) / (d || 1);

      if (input.tackle && p.cooldown <= 0) {
        ball.vx = p.facing * 330 + dx * 70;
        ball.vy = dy * 180;
        p.cooldown = 0.8;
      } else if (input.shoot && p.cooldown <= 0) {
        const aimX = Math.abs(dx) > 0.2 ? dx : p.facing;
        const aimY = Math.abs(dy) > 0.2 ? dy : (ball.y - p.y) / (d || 1) * 0.35;
        const len = Math.hypot(aimX, aimY) || 1;
        ball.vx = aimX / len * 520;
        ball.vy = aimY / len * 520;
        p.cooldown = 0.55;
      } else if (input.pass && p.cooldown <= 0) {
        const teammates = players
          .filter(q => q.id !== p.id && q.team === p.team)
          .sort((a, b) => dist(a, ball) - dist(b, ball));
        const target = teammates[0];

        if (target) {
          const tx = target.x - ball.x;
          const ty = target.y - ball.y;
          const len = Math.hypot(tx, ty) || 1;
          ball.vx = tx / len * 360;
          ball.vy = ty / len * 360;
        } else {
          ball.vx = p.facing * 300;
          ball.vy = 0;
        }
        p.cooldown = 0.45;
      } else {
        const targetX = p.x + p.facing * (PLAYER_R + BALL_R + 3);
        const targetY = p.y + dy * 10;
        ball.vx += (targetX - ball.x) * 8 * dt;
        ball.vy += (targetY - ball.y) * 8 * dt;
      }
    } else if (d < 60 && input.tackle && p.cooldown <= 0) {
      const enemy = players.find(q => q.team !== p.team && dist(q, p) < 60);
      if (enemy) {
        enemy.vx = p.facing * 170;
        enemy.vy = dy * 150;
        p.cooldown = 0.8;
      }
    }
  }

  // Basic player collision
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      const d = dist(a, b);
      const min = PLAYER_R * 2;
      if (d > 0 && d < min) {
        const push = (min - d) / 2;
        const nx = (b.x - a.x) / d;
        const ny = (b.y - a.y) / d;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
      }
    }
  }

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  const friction = Math.pow(0.985, dt * 60);
  ball.vx *= friction;
  ball.vy *= friction;

  if (ball.y < BALL_R || ball.y > FIELD.h - BALL_R) {
    ball.y = clamp(ball.y, BALL_R, FIELD.h - BALL_R);
    ball.vy *= -0.75;
  }

  // Goal detection
  if (ball.x <= BALL_R && ball.y >= GOAL_TOP && ball.y <= GOAL_BOTTOM) {
    goal(room, "blue");
    return;
  }
  if (ball.x >= FIELD.w - BALL_R && ball.y >= GOAL_TOP && ball.y <= GOAL_BOTTOM) {
    goal(room, "red");
    return;
  }

  // Side walls and end walls outside goal
  if (ball.x < BALL_R || ball.x > FIELD.w - BALL_R) {
    ball.x = clamp(ball.x, BALL_R, FIELD.w - BALL_R);
    ball.vx *= -0.75;
  }

  // Out-of-bounds player protection
  for (const p of players) {
    p.x = clamp(p.x, PLAYER_R, FIELD.w - PLAYER_R);
    p.y = clamp(p.y, PLAYER_R, FIELD.h - PLAYER_R);
  }
}

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    const dt = Math.min((now - room.lastTick) / 1000, 0.05);
    room.lastTick = now;

    simulate(room, dt);

    if (room.status === "playing") {
      io.to(room.code).emit("gameState", {
        players: [...room.players.values()].map(p => ({
          id: p.id,
          name: p.name,
          team: p.team,
          x: p.x,
          y: p.y,
          facing: p.facing
        })),
        ball: room.ball,
        score: room.score,
        time: Math.ceil(room.time)
      });
    }
  }
}, 1000 / 30);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Football Arena berjalan di port ${PORT}`);
});
