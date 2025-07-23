import express from "express";
import http from "http";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});
app.use(cors());

// Serve static files
app.use(express.static("public"));
app.use("/hls", express.static("hls"));

// Global variables
let worker;
let router;
const peers = new Map();

// Maps to store room and HLS information
const rooms = new Map(); // Map to store room information
const hlsProcesses = new Map(); // Map to store HLS processes

// Server port
const PORT = process.env.PORT || 3001;

// Helper function to log with timestamp
function debug(message, ...args) {
  console.log(`[SERVER] ${new Date().toISOString()} - ${message}`, ...args);
}

// Create HLS directory if it doesn't exist
const HLS_BASE_DIR = path.join(__dirname, "hls");
if (!fs.existsSync(HLS_BASE_DIR)) {
  fs.mkdirSync(HLS_BASE_DIR, { recursive: true });
  debug(`Created HLS base directory: ${HLS_BASE_DIR}`);
}

// Initialize MediaSoup worker and router
const createWorker = async () => {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });
  debug("MediaSoup worker created");

  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
          "x-google-start-bitrate": 1000,
        },
      },
      {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
          "packetization-mode": 1,
          "profile-level-id": "4d0032",
          "level-asymmetry-allowed": 1,
        },
      },
    ],
  });
  debug("MediaSoup router created");

  return router;
};

// Call the function to initialize worker and router
createWorker();

function getPeer(socketId) {
  if (!peers.has(socketId)) {
    peers.set(socketId, {
      transports: [],
      producers: [],
      consumers: [],
      roomId: null,
    });
  }
  return peers.get(socketId);
}

// HLS Functions
async function createAudioSDP(audioConsumer, port, streamIndex = 0) {
  if (!audioConsumer) return "";

  const sdpLines = [];
  sdpLines.push(`v=0`);
  sdpLines.push(`o=mediasoup 0 0 IN IP4 127.0.0.1`);
  sdpLines.push(`s=Audio Stream ${streamIndex + 1}`);
  sdpLines.push(`c=IN IP4 127.0.0.1`);
  sdpLines.push(`t=0 0`);

  const baseCodec = audioConsumer.rtpParameters.codecs[0];
  const payloadType = baseCodec.payloadType;
  const clockRate = baseCodec.clockRate;
  const channels = baseCodec.channels || 2;

  // Media description
  sdpLines.push(`m=audio ${port} RTP/AVP ${payloadType}`);

  // Handle OPUS codec specifically
  if (baseCodec.mimeType.toLowerCase().includes("opus")) {
    sdpLines.push(`a=rtpmap:${payloadType} opus/${clockRate}/${channels}`);
    sdpLines.push(
      `a=fmtp:${payloadType} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxplaybackrate=48000;cbr=1`
    );
  } else {
    const codecMime = baseCodec.mimeType.split("/")[1];
    sdpLines.push(
      `a=rtpmap:${payloadType} ${codecMime}/${clockRate}${
        channels > 1 ? `/${channels}` : ""
      }`
    );
  }

  // RTCP and direction
  sdpLines.push(`a=rtcp:${port + 1} IN IP4 127.0.0.1`);
  sdpLines.push(`a=sendonly`);
  sdpLines.push(`a=control:streamid=${streamIndex}`);
  sdpLines.push(`a=ts-refclk:local`);
  sdpLines.push(`a=ptime:20`);
  sdpLines.push(`a=x-receivebuffer:4096`);

  return sdpLines.join("\n") + "\n";
}

async function createVideoSDP(videoConsumer, port, streamIndex = 0) {
  const sdpLines = [];
  sdpLines.push(`v=0`);
  sdpLines.push(`o=mediasoup 0 0 IN IP4 127.0.0.1`);
  sdpLines.push(`s=Video Stream ${streamIndex + 1}`);
  sdpLines.push(`c=IN IP4 127.0.0.1`);
  sdpLines.push(`t=0 0`);

  const rtpParams = videoConsumer.rtpParameters;
  const codec = rtpParams.codecs[0];
  const payloadType = codec.payloadType;

  // Media description
  sdpLines.push(`m=video ${port} RTP/AVP ${payloadType}`);

  // Handle H264 or VP8 codec
  if (codec.mimeType.toLowerCase().includes("h264")) {
    sdpLines.push(`a=rtpmap:${payloadType} H264/90000`);

    let fmtpParams = [];
    if (codec.parameters) {
      const profileLevelId = codec.parameters["profile-level-id"] || "42e01e";
      fmtpParams.push(`profile-level-id=${profileLevelId}`);

      const packetizationMode = codec.parameters["packetization-mode"] || "1";
      fmtpParams.push(`packetization-mode=${packetizationMode}`);

      if (codec.parameters["level-asymmetry-allowed"]) {
        fmtpParams.push(
          `level-asymmetry-allowed=${codec.parameters["level-asymmetry-allowed"]}`
        );
      }
    } else {
      fmtpParams.push("profile-level-id=42e01e");
      fmtpParams.push("packetization-mode=1");
    }

    sdpLines.push(`a=fmtp:${payloadType} ${fmtpParams.join(";")}`);
  } else if (codec.mimeType.toLowerCase().includes("vp8")) {
    sdpLines.push(`a=rtpmap:${payloadType} VP8/90000`);
  }

  // RTCP and direction
  sdpLines.push(`a=rtcp:${port + 1} IN IP4 127.0.0.1`);
  sdpLines.push(`a=sendonly`);

  return sdpLines.join("\n") + "\n";
}

async function startHLS(roomId) {
  debug(`Starting HLS for room ${roomId}`);

  if (hlsProcesses.has(roomId)) {
    debug(`HLS already started for room ${roomId}`);
    return;
  }

  const room = rooms.get(roomId);
  if (!room || !room.producers || room.producers.size === 0) {
    debug(`No producers found in room ${roomId}`);
    throw new Error("No producers found for HLS");
  }

  const audioProducers = [];
  const videoProducers = [];

  // Collect all producers from the room
  for (const [_, producers] of room.producers) {
    for (const producer of producers) {
      if (producer.kind === "audio") {
        audioProducers.push(producer);
      } else if (producer.kind === "video") {
        videoProducers.push(producer);
      }
    }
  }

  debug(
    `Found ${audioProducers.length} audio producers and ${videoProducers.length} video producers`
  );

  if (audioProducers.length === 0 || videoProducers.length === 0) {
    debug(`Not enough producers to start HLS`);
    throw new Error("Need at least one audio and one video producer for HLS");
  }

  // Define FFmpeg listening IPs and Ports
  const FFMPEG_HOST = "127.0.0.1";
  const FFMPEG_AUDIO_PORT = 5004;
  const FFMPEG_VIDEO_BASE_PORT = 5008;

  // Arrays to store all transports and consumers for cleanup
  const allTransports = [];
  const allConsumers = [];

  try {
    // Create output directory
    const outputDir = path.join(HLS_BASE_DIR, roomId);
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });
    debug(`Created output directory: ${outputDir}`);

    // Create audio transports and consumers
    const audioTransports = [];
    const audioConsumers = [];

    for (let i = 0; i < Math.min(audioProducers.length, 2); i++) {
      const audioPort = FFMPEG_AUDIO_PORT + i * 2;
      const audioTransport = await router.createPlainTransport({
        listenIp: { ip: FFMPEG_HOST, announcedIp: undefined },
        enableSctp: false,
        comedia: false,
        rtcpMux: false,
      });

      audioTransports.push(audioTransport);
      allTransports.push(audioTransport);

      await audioTransport.connect({
        ip: FFMPEG_HOST,
        port: audioPort,
        rtcpPort: audioPort + 1,
      });

      const audioConsumer = await audioTransport.consume({
        producerId: audioProducers[i].id,
        rtpCapabilities: router.rtpCapabilities,
        paused: true,
      });

      audioConsumers.push(audioConsumer);
      allConsumers.push(audioConsumer);
    }

    // Create video transports and consumers
    const videoTransports = [];
    const videoConsumers = [];

    for (let i = 0; i < Math.min(videoProducers.length, 2); i++) {
      const videoPort = FFMPEG_VIDEO_BASE_PORT + i * 4;
      const videoTransport = await router.createPlainTransport({
        listenIp: { ip: FFMPEG_HOST, announcedIp: undefined },
        enableSctp: false,
        comedia: false,
        rtcpMux: false,
      });

      videoTransports.push(videoTransport);
      allTransports.push(videoTransport);

      await videoTransport.connect({
        ip: FFMPEG_HOST,
        port: videoPort,
        rtcpPort: videoPort + 1,
      });

      const videoConsumer = await videoTransport.consume({
        producerId: videoProducers[i].id,
        rtpCapabilities: router.rtpCapabilities,
        paused: true,
      });

      videoConsumers.push(videoConsumer);
      allConsumers.push(videoConsumer);

      // Request keyframes
      videoConsumer.requestKeyFrame();
    }

    // Create SDP files
    for (let i = 0; i < audioConsumers.length; i++) {
      const audioPort = FFMPEG_AUDIO_PORT + i * 2;
      const audioSDP = await createAudioSDP(audioConsumers[i], audioPort, i);
      fs.writeFileSync(path.join(outputDir, `audio${i + 1}.sdp`), audioSDP);
    }

    for (let i = 0; i < videoConsumers.length; i++) {
      const videoPort = FFMPEG_VIDEO_BASE_PORT + i * 4;
      const videoSDP = await createVideoSDP(videoConsumers[i], videoPort, i);
      fs.writeFileSync(path.join(outputDir, `video${i + 1}.sdp`), videoSDP);
    }

    // Build FFmpeg command
    const ffmpegArgs = [
      "-loglevel",
      "debug",
      "-y",

      // Global options
      "-fflags",
      "+genpts+discardcorrupt+nobuffer",
      "-avoid_negative_ts",
      "make_zero",
      "-thread_queue_size",
      "1024",
      "-protocol_whitelist",
      "file,udp,rtp,rtcp,crypto,data",
    ];

    // Add audio inputs
    for (let i = 0; i < audioConsumers.length; i++) {
      ffmpegArgs.push("-protocol_whitelist", "file,udp,rtp,rtcp,crypto,data");
      ffmpegArgs.push("-f", "sdp");
      ffmpegArgs.push("-c:a", "libopus");
      ffmpegArgs.push("-i", path.join(outputDir, `audio${i + 1}.sdp`));
    }

    // Add video inputs
    for (let i = 0; i < videoConsumers.length; i++) {
      ffmpegArgs.push("-protocol_whitelist", "file,udp,rtp,rtcp,crypto,data");
      ffmpegArgs.push("-f", "sdp");
      ffmpegArgs.push("-i", path.join(outputDir, `video${i + 1}.sdp`));
    }

    // Add filter complex for audio mixing and video layout
    const firstVideoInputIndex = audioConsumers.length;
    let filterComplexString = "";

    // Audio mixing
    if (audioConsumers.length > 0) {
      if (audioConsumers.length > 1) {
        filterComplexString = `[0:a][1:a]amix=inputs=2[audio_out];`;
      } else {
        filterComplexString = `[0:a]aresample=48000[audio_out];`;
      }
    } else {
      filterComplexString =
        "anullsrc=channel_layout=stereo:sample_rate=48000[audio_out];";
    }

    // Video layout (side-by-side if 2 videos)
    if (videoConsumers.length === 2) {
      filterComplexString +=
        `[${firstVideoInputIndex}:v]scale=640:480[left];` +
        `[${firstVideoInputIndex + 1}:v]scale=640:480[right];` +
        `[left][right]hstack=inputs=2[video_out]`;
    } else if (videoConsumers.length === 1) {
      filterComplexString += `[${firstVideoInputIndex}:v]scale=1280:720[video_out]`;
    }

    ffmpegArgs.push("-filter_complex", filterComplexString);
    ffmpegArgs.push("-map", "[audio_out]", "-map", "[video_out]");

    // Add encoding and HLS settings
    ffmpegArgs.push(
      // Audio encoding
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-ac",
      "2",

      // Video encoding
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "main",
      "-level",
      "4.0",
      "-b:v",
      "1500k",
      "-maxrate",
      "1800k",
      "-bufsize",
      "3000k",
      "-g",
      "48",
      "-keyint_min",
      "48",
      "-sc_threshold",
      "0",
      "-r",
      "24",

      // HLS settings
      "-f",
      "hls",
      "-hls_time",
      "2",
      "-hls_list_size",
      "5",
      "-hls_flags",
      "delete_segments+append_list+discont_start+omit_endlist",
      "-hls_delete_threshold",
      "1",
      "-hls_segment_type",
      "mpegts",
      "-hls_segment_filename",
      path.join(outputDir, "segment_%d.ts"),
      path.join(outputDir, "index.m3u8")
    );

    // Spawn FFmpeg process
    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
      cwd: outputDir,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    ffmpegProcess.stdout.on("data", (data) => {
      debug(`FFmpeg stdout: ${data.toString()}`);
    });

    ffmpegProcess.stderr.on("data", (data) => {
      debug(`FFmpeg stderr: ${data.toString()}`);
    });

    ffmpegProcess.on("close", (code) => {
      debug(`FFmpeg process for room ${roomId} exited with code ${code}`);
      stopHLS(roomId);
    });

    ffmpegProcess.on("error", (err) => {
      debug(
        `Failed to start FFmpeg process for room ${roomId}: ${err.message}`
      );
      stopHLS(roomId);
    });

    // Store process info
    hlsProcesses.set(roomId, {
      ffmpegProcess,
      audioTransports,
      videoTransports,
      audioConsumers,
      videoConsumers,
      outputDir,
    });

    // Resume consumers after a delay
    setTimeout(async () => {
      try {
        for (const consumer of allConsumers) {
          if (consumer.kind === "video") {
            await consumer.requestKeyFrame();
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          await consumer.resume();
          debug(`Resumed consumer ${consumer.id}`);
        }
        debug(`All consumers resumed for room ${roomId}`);

        // Set up periodic keyframe requests
        const keyframeInterval = setInterval(() => {
          videoConsumers.forEach((consumer) => {
            consumer.requestKeyFrame();
          });
        }, 5000);

        // Store the interval for cleanup
        const hlsProcess = hlsProcesses.get(roomId);
        if (hlsProcess) {
          hlsProcess.keyframeInterval = keyframeInterval;
        }
      } catch (error) {
        debug(`Error resuming consumers: ${error.message}`);
      }
    }, 3000);

    debug(`HLS started for room ${roomId}`);
    return {
      playlistPath: `hls/${roomId}/index.m3u8`,
      outputDir,
    };
  } catch (error) {
    debug(`Error during HLS setup: ${error.message}`);
    // Cleanup resources on error
    allTransports.forEach((transport) => transport.close());
    allConsumers.forEach((consumer) => consumer.close());
    throw error;
  }
}

async function stopHLS(roomId) {
  debug(`Stopping HLS for room ${roomId}`);

  const hlsData = hlsProcesses.get(roomId);
  if (!hlsData) {
    debug(`No HLS process found for room ${roomId}`);
    return;
  }

  const {
    ffmpegProcess,
    audioTransports,
    videoTransports,
    audioConsumers,
    videoConsumers,

    keyframeInterval,
  } = hlsData;

  // Kill FFmpeg process
  if (ffmpegProcess && !ffmpegProcess.killed) {
    ffmpegProcess.kill("SIGTERM");
    debug(`Terminated FFmpeg process for room ${roomId}`);
  }

  // Clear keyframe interval if exists
  if (keyframeInterval) {
    clearInterval(keyframeInterval);
  }

  // Close consumers
  if (audioConsumers) {
    audioConsumers.forEach((consumer) => {
      if (!consumer.closed) consumer.close();
    });
  }

  if (videoConsumers) {
    videoConsumers.forEach((consumer) => {
      if (!consumer.closed) consumer.close();
    });
  }

  // Close transports
  if (audioTransports) {
    audioTransports.forEach((transport) => {
      if (!transport.closed) transport.close();
    });
  }

  if (videoTransports) {
    videoTransports.forEach((transport) => {
      if (!transport.closed) transport.close();
    });
  }

  // Remove from map
  hlsProcesses.delete(roomId);

  debug(`HLS stopped for room ${roomId}`);
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Initialize peer data
  getPeer(socket.id);

  socket.on("ready", () => {
    // Get all connected peers except this one
    const others = Array.from(peers.keys()).filter((id) => id !== socket.id);
    socket.emit("other-users", others);
  });

  socket.on("joinRoom", ({ roomId }, cb) => {
    try {
      console.log(`Socket ${socket.id} joining room ${roomId}`);

      // Create room if it doesn't exist
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          id: roomId,
          peers: new Set(),
          producers: new Map(),
          consumers: new Map(),
        });
        console.log(`Created new room: ${roomId}`);
      }

      const room = rooms.get(roomId);
      room.peers.add(socket.id);

      // Store room ID in peer data
      const peer = getPeer(socket.id);
      peer.roomId = roomId;

      // Join the socket.io room
      socket.join(roomId);

      cb({ success: true });
    } catch (error) {
      console.error("Error joining room:", error);
      cb({ error: error.message });
    }
  });

  socket.on("getRtpCapabilities", (cb) => {
    cb(router.rtpCapabilities);
  });

  socket.on("createTransport", async (cb) => {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: "127.0.0.1", announcedIp: null }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });

    getPeer(socket.id).transports.push(transport);

    cb({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    });
  });

  socket.on("connectTransport", async ({ transportId, dtlsParameters }, cb) => {
    const peer = getPeer(socket.id);
    const transport = peer.transports.find((t) => t.id === transportId);
    await transport.connect({ dtlsParameters });
    cb();
  });

  socket.on("produce", async ({ transportId, kind, rtpParameters }, cb) => {
    const peer = getPeer(socket.id);
    const transport = peer.transports.find((t) => t.id === transportId);

    const producer = await transport.produce({ kind, rtpParameters });
    peer.producers.push(producer);

    // Store producer in room data if in a room
    const roomId = peer.roomId;
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        if (!room.producers.has(socket.id)) {
          room.producers.set(socket.id, []);
        }
        room.producers.get(socket.id).push(producer);

        // Notify other clients in the same room
        socket.to(roomId).emit("newProducer", {
          producerId: producer.id,
          kind,
          socketId: socket.id,
        });
      }
    } else {
      // Fallback to broadcasting to all if not in a room
      socket.broadcast.emit("newProducer", {
        producerId: producer.id,
        kind,
        socketId: socket.id,
      });
    }

    cb({ id: producer.id });
  });

  socket.on("getProducers", (cb) => {
    const peer = getPeer(socket.id);
    const roomId = peer.roomId;

    if (roomId && rooms.has(roomId)) {
      // Get producers from the room
      const room = rooms.get(roomId);
      const producersList = [];

      room.producers.forEach((producers, otherSocketId) => {
        if (otherSocketId !== socket.id) {
          producers.forEach((producer) => {
            producersList.push({
              producerId: producer.id,
              kind: producer.kind,
              socketId: otherSocketId,
            });
          });
        }
      });

      cb(producersList);
    } else {
      // If not in a room, return empty list
      debug("Peer not in any room, no producers to get");
      cb([]);
    }
  });

  socket.on(
    "consume",
    async ({ producerId, rtpCapabilities, transportId }, cb) => {
      try {
        const peer = getPeer(socket.id);
        const transport = peer.transports.find((t) => t.id === transportId);

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });

        peer.consumers.push(consumer);

        // Store consumer in room data if in a room
        const roomId = peer.roomId;
        if (roomId) {
          const room = rooms.get(roomId);
          if (room) {
            if (!room.consumers.has(socket.id)) {
              room.consumers.set(socket.id, []);
            }
            room.consumers.get(socket.id).push(consumer);
          }
        }

        cb({
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (err) {
        console.error("Consume error:", err);
        cb({ error: err.message });
      }
    }
  );

  socket.on("startHLS", async (cb) => {
    try {
      const peer = getPeer(socket.id);
      const roomId = peer.roomId;

      if (!roomId) {
        throw new Error("You must join a room before starting HLS");
      }

      await startHLS(roomId);
      cb({ success: true, playlistUrl: `/hls/${roomId}/index.m3u8` });
    } catch (error) {
      console.error("Error starting HLS:", error);
      cb({ error: error.message });
    }
  });

  socket.on("stopHLS", async (cb) => {
    try {
      const peer = getPeer(socket.id);
      const roomId = peer.roomId;

      if (!roomId) {
        throw new Error("You must join a room before stopping HLS");
      }

      await stopHLS(roomId);
      cb({ success: true });
    } catch (error) {
      console.error("Error stopping HLS:", error);
      cb({ error: error.message });
    }
  });

  socket.on("disconnect", () => {
    console.log("peer disconnected", socket.id);

    const peer = peers.get(socket.id);
    if (peer) {
      const roomId = peer.roomId;

      // Remove peer from room
      if (roomId && rooms.has(roomId)) {
        const room = rooms.get(roomId);
        room.peers.delete(socket.id);
        room.producers.delete(socket.id);
        room.consumers.delete(socket.id);

        // If room is empty, stop HLS and remove room
        if (room.peers.size === 0) {
          if (hlsProcesses.has(roomId)) {
            stopHLS(roomId).catch((error) => {
              console.error(`Error stopping HLS for room ${roomId}:`, error);
            });
          }
          rooms.delete(roomId);
          debug(`Room ${roomId} deleted as it's empty`);
        }
      }

      peer.transports.forEach((t) => t.close());
      peer.producers.forEach((p) => p.close());
      peer.consumers.forEach((c) => c.close());
    }

    peers.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
