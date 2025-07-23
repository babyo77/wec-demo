import express from "express";
import http from "http";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3001;
// Configuration constants
const CONFIG = {
  PORT: process.env.PORT || 3001,
  MEDIASOUP: {
    LOG_LEVEL: "warn",
    LOG_TAGS: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
    RTC_MIN_PORT: 40000,
    RTC_MAX_PORT: 49999,
  },
  HLS: {
    FFMPEG_HOST: "127.0.0.1",
    AUDIO_PORT: 5004,
    VIDEO_BASE_PORT: 5008,
    SEGMENT_DURATION: 2,
    PLAYLIST_SIZE: 5,
    KEYFRAME_INTERVAL: 5000,
  },
  TRANSPORT: {
    listenIps: [
      {
        ip: "127.0.0.1",
        announcedIp: null,
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    maxIncomingBitrate: 1500000,
  },
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

app.use(cors());
app.use(express.static("public"));
app.use("/hls", express.static("hls"));

// Global state
let worker;
let router;
const peers = new Map();
const rooms = new Map();
const hlsProcesses = new Map();

// Enhanced logging with levels
const logger = {
  debug: (message, ...args) => {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, ...args);
    }
  },
  info: (message, ...args) => {
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`, ...args);
  },
  error: (message, ...args) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, ...args);
  },
  warn: (message, ...args) => {
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, ...args);
  },
};

// Legacy debug function for backward compatibility
function debug(message, ...args) {
  logger.debug(message, ...args);
}

// Media codecs configuration
const MEDIA_CODECS = [
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
];

// Initialize HLS directory
const HLS_BASE_DIR = path.join(__dirname, "hls");

async function initializeHLSDirectory() {
  try {
    await fs.access(HLS_BASE_DIR);
    logger.debug(`HLS directory already exists: ${HLS_BASE_DIR}`);
  } catch {
    await fs.mkdir(HLS_BASE_DIR, { recursive: true });
    logger.info(`Created HLS base directory: ${HLS_BASE_DIR}`);
  }
}

// Initialize MediaSoup worker and router
async function createWorker() {
  try {
    worker = await mediasoup.createWorker({
      logLevel: CONFIG.MEDIASOUP.LOG_LEVEL,
      logTags: CONFIG.MEDIASOUP.LOG_TAGS,
      rtcMinPort: CONFIG.MEDIASOUP.RTC_MIN_PORT,
      rtcMaxPort: CONFIG.MEDIASOUP.RTC_MAX_PORT,
    });

    worker.on("died", () => {
      logger.error("MediaSoup worker died, exiting process");
      process.exit(1);
    });

    logger.info("MediaSoup worker created successfully");

    router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    logger.info("MediaSoup router created successfully");

    return router;
  } catch (error) {
    logger.error("Failed to create MediaSoup worker/router:", error);
    throw error;
  }
}

// Initialize server components
async function initializeServer() {
  try {
    await initializeHLSDirectory();
    await createWorker();
    logger.info("Server initialization completed");
  } catch (error) {
    logger.error("Server initialization failed:", error);
    process.exit(1);
  }
}

// Start initialization
initializeServer();

// Utility functions
function getPeer(socketId) {
  if (!peers.has(socketId)) {
    peers.set(socketId, {
      transports: new Set(),
      producers: new Set(),
      consumers: new Set(),
      roomId: null,
      createdAt: Date.now(),
    });
  }
  return peers.get(socketId);
}

function validateConsumer(consumer) {
  if (!consumer || !consumer.rtpParameters || !consumer.rtpParameters.codecs) {
    throw new Error("Invalid consumer or missing RTP parameters");
  }
  return consumer.rtpParameters.codecs[0];
}

// Optimized HLS SDP creation functions
function createAudioSDP(audioConsumer, port, streamIndex = 0) {
  if (!audioConsumer) {
    logger.warn("No audio consumer provided for SDP creation");
    return "";
  }

  try {
    const baseCodec = validateConsumer(audioConsumer);
    const { payloadType, clockRate, mimeType } = baseCodec;
    const channels = baseCodec.channels || 2;

    const sdpLines = [
      "v=0",
      "o=mediasoup 0 0 IN IP4 127.0.0.1",
      `s=Audio Stream ${streamIndex + 1}`,
      "c=IN IP4 127.0.0.1",
      "t=0 0",
      `m=audio ${port} RTP/AVP ${payloadType}`,
    ];

    // Codec-specific configuration
    if (mimeType.toLowerCase().includes("opus")) {
      sdpLines.push(
        `a=rtpmap:${payloadType} opus/${clockRate}/${channels}`,
        `a=fmtp:${payloadType} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxplaybackrate=48000;cbr=1`
      );
    } else {
      const codecName = mimeType.split("/")[1];
      const channelSuffix = channels > 1 ? `/${channels}` : "";
      sdpLines.push(
        `a=rtpmap:${payloadType} ${codecName}/${clockRate}${channelSuffix}`
      );
    }

    // Common attributes
    sdpLines.push(
      `a=rtcp:${port + 1} IN IP4 127.0.0.1`,
      "a=sendonly",
      `a=control:streamid=${streamIndex}`,
      "a=ts-refclk:local",
      "a=ptime:20",
      "a=x-receivebuffer:4096"
    );

    return sdpLines.join("\n") + "\n";
  } catch (error) {
    logger.error("Error creating audio SDP:", error);
    return "";
  }
}

function createVideoSDP(videoConsumer, port, streamIndex = 0) {
  if (!videoConsumer) {
    logger.warn("No video consumer provided for SDP creation");
    return "";
  }

  try {
    const codec = validateConsumer(videoConsumer);
    const { payloadType, mimeType, parameters = {} } = codec;

    const sdpLines = [
      "v=0",
      "o=mediasoup 0 0 IN IP4 127.0.0.1",
      `s=Video Stream ${streamIndex + 1}`,
      "c=IN IP4 127.0.0.1",
      "t=0 0",
      `m=video ${port} RTP/AVP ${payloadType}`,
    ];

    // Codec-specific configuration
    if (mimeType.toLowerCase().includes("h264")) {
      sdpLines.push(`a=rtpmap:${payloadType} H264/90000`);

      const fmtpParams = [
        `profile-level-id=${parameters["profile-level-id"] || "42e01e"}`,
        `packetization-mode=${parameters["packetization-mode"] || "1"}`,
      ];

      if (parameters["level-asymmetry-allowed"]) {
        fmtpParams.push(
          `level-asymmetry-allowed=${parameters["level-asymmetry-allowed"]}`
        );
      }

      sdpLines.push(`a=fmtp:${payloadType} ${fmtpParams.join(";")}`);
    } else if (mimeType.toLowerCase().includes("vp8")) {
      sdpLines.push(`a=rtpmap:${payloadType} VP8/90000`);
    }

    // Common attributes
    sdpLines.push(`a=rtcp:${port + 1} IN IP4 127.0.0.1`, "a=sendonly");

    return sdpLines.join("\n") + "\n";
  } catch (error) {
    logger.error("Error creating video SDP:", error);
    return "";
  }
}

async function startHLS(roomId) {
  logger.info(`Starting HLS for room ${roomId}`);

  if (hlsProcesses.has(roomId)) {
    logger.warn(`HLS already started for room ${roomId}`);
    return hlsProcesses.get(roomId);
  }

  const room = rooms.get(roomId);
  if (!room?.producers || room.producers.size === 0) {
    const error = new Error(`No producers found in room ${roomId}`);
    logger.error(error.message);
    throw error;
  }

  const { audioProducers, videoProducers } = collectProducers(room);

  logger.debug(
    `Found ${audioProducers.length} audio and ${videoProducers.length} video producers`
  );

  if (audioProducers.length === 0 || videoProducers.length === 0) {
    const error = new Error(
      "Need at least one audio and one video producer for HLS"
    );
    logger.error(error.message);
    throw error;
  }

  const resources = {
    transports: [],
    consumers: [],
    outputDir: null,
    ffmpegProcess: null,
  };

  try {
    return await createHLSStream(
      roomId,
      audioProducers,
      videoProducers,
      resources
    );
  } catch (error) {
    logger.error(`Failed to start HLS for room ${roomId}:`, error);
    await cleanupHLSResources(resources);
    throw error;
  }
}

function collectProducers(room) {
  const audioProducers = [];
  const videoProducers = [];

  for (const producers of room.producers.values()) {
    for (const producer of producers) {
      if (producer.kind === "audio") {
        audioProducers.push(producer);
      } else if (producer.kind === "video") {
        videoProducers.push(producer);
      }
    }
  }

  return { audioProducers, videoProducers };
}

async function createHLSStream(
  roomId,
  audioProducers,
  videoProducers,
  resources
) {
  // Setup output directory
  const outputDir = path.join(HLS_BASE_DIR, roomId);
  resources.outputDir = outputDir;

  await setupOutputDirectory(outputDir);

  // Create consumers and transports
  const { audioConsumers, videoConsumers } = await createConsumersAndTransports(
    audioProducers,
    videoProducers,
    resources
  );

  // Generate SDP files
  await generateSDPFiles(audioConsumers, videoConsumers, outputDir);

  // Start FFmpeg process
  const ffmpegProcess = await startFFmpegProcess(
    audioConsumers,
    videoConsumers,
    outputDir
  );
  resources.ffmpegProcess = ffmpegProcess;

  // Store HLS process data
  const hlsData = {
    ffmpegProcess,
    audioTransports: resources.transports.filter(
      (_, i) => i < audioConsumers.length
    ),
    videoTransports: resources.transports.filter(
      (_, i) => i >= audioConsumers.length
    ),
    audioConsumers,
    videoConsumers,
    outputDir,
  };

  hlsProcesses.set(roomId, hlsData);

  // Resume consumers and setup keyframe requests
  await setupConsumerResumption(audioConsumers, videoConsumers, roomId);

  logger.info(`HLS started successfully for room ${roomId}`);
  return {
    playlistPath: `hls/${roomId}/index.m3u8`,
    outputDir,
  };
}

async function setupOutputDirectory(outputDir) {
  try {
    await fs.access(outputDir);
    await fs.rm(outputDir, { recursive: true, force: true });
  } catch {
    // Directory doesn't exist, which is fine
  }
  await fs.mkdir(outputDir, { recursive: true });
  logger.debug(`Created output directory: ${outputDir}`);
}

async function createConsumersAndTransports(
  audioProducers,
  videoProducers,
  resources
) {
  const maxStreams = 2;
  const audioConsumers = [];
  const videoConsumers = [];

  // Create audio consumers
  for (let i = 0; i < Math.min(audioProducers.length, maxStreams); i++) {
    const port = CONFIG.HLS.AUDIO_PORT + i * 2;
    const { transport, consumer } = await createPlainTransportAndConsumer(
      audioProducers[i],
      port
    );
    resources.transports.push(transport);
    resources.consumers.push(consumer);
    audioConsumers.push(consumer);
  }

  // Create video consumers
  for (let i = 0; i < Math.min(videoProducers.length, maxStreams); i++) {
    const port = CONFIG.HLS.VIDEO_BASE_PORT + i * 4;
    const { transport, consumer } = await createPlainTransportAndConsumer(
      videoProducers[i],
      port
    );
    resources.transports.push(transport);
    resources.consumers.push(consumer);
    videoConsumers.push(consumer);

    // Request initial keyframe
    consumer.requestKeyFrame();
  }

  return { audioConsumers, videoConsumers };
}

async function createPlainTransportAndConsumer(producer, port) {
  const transport = await router.createPlainTransport({
    listenIp: { ip: CONFIG.HLS.FFMPEG_HOST, announcedIp: undefined },
    enableSctp: false,
    comedia: false,
    rtcpMux: false,
  });

  await transport.connect({
    ip: CONFIG.HLS.FFMPEG_HOST,
    port,
    rtcpPort: port + 1,
  });

  const consumer = await transport.consume({
    producerId: producer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: true,
  });

  return { transport, consumer };
}

async function generateSDPFiles(audioConsumers, videoConsumers, outputDir) {
  const sdpPromises = [];

  // Generate audio SDP files
  audioConsumers.forEach((consumer, i) => {
    const port = CONFIG.HLS.AUDIO_PORT + i * 2;
    const sdpContent = createAudioSDP(consumer, port, i);
    const filePath = path.join(outputDir, `audio${i + 1}.sdp`);
    sdpPromises.push(fs.writeFile(filePath, sdpContent));
  });

  // Generate video SDP files
  videoConsumers.forEach((consumer, i) => {
    const port = CONFIG.HLS.VIDEO_BASE_PORT + i * 4;
    const sdpContent = createVideoSDP(consumer, port, i);
    const filePath = path.join(outputDir, `video${i + 1}.sdp`);
    sdpPromises.push(fs.writeFile(filePath, sdpContent));
  });

  await Promise.all(sdpPromises);
  logger.debug("SDP files generated successfully");
}

async function startFFmpegProcess(audioConsumers, videoConsumers, outputDir) {
  const ffmpegArgs = buildFFmpegArgs(audioConsumers, videoConsumers, outputDir);

  const ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
    cwd: outputDir,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  setupFFmpegEventHandlers(ffmpegProcess, outputDir);
  return ffmpegProcess;
}

function buildFFmpegArgs(audioConsumers, videoConsumers, outputDir) {
  const ffmpegArgs = [
    "-loglevel",
    "error",
    "-y",
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
  audioConsumers.forEach((_, i) => {
    ffmpegArgs.push(
      "-protocol_whitelist",
      "file,udp,rtp,rtcp,crypto,data",
      "-f",
      "sdp",
      "-c:a",
      "libopus",
      "-i",
      path.join(outputDir, `audio${i + 1}.sdp`)
    );
  });

  // Add video inputs
  videoConsumers.forEach((_, i) => {
    ffmpegArgs.push(
      "-protocol_whitelist",
      "file,udp,rtp,rtcp,crypto,data",
      "-f",
      "sdp",
      "-i",
      path.join(outputDir, `video${i + 1}.sdp`)
    );
  });

  // Add filter complex
  const filterComplex = buildFilterComplex(
    audioConsumers.length,
    videoConsumers.length
  );
  ffmpegArgs.push("-filter_complex", filterComplex);
  ffmpegArgs.push("-map", "[audio_out]", "-map", "[video_out]");

  // Add encoding and HLS settings
  ffmpegArgs.push(
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
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
    "-f",
    "hls",
    "-hls_time",
    CONFIG.HLS.SEGMENT_DURATION.toString(),
    "-hls_list_size",
    CONFIG.HLS.PLAYLIST_SIZE.toString(),
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

  return ffmpegArgs;
}

function buildFilterComplex(audioCount, videoCount) {
  let filterComplex = "";

  // Audio mixing
  if (audioCount > 1) {
    filterComplex = "[0:a][1:a]amix=inputs=2[audio_out];";
  } else if (audioCount === 1) {
    filterComplex = "[0:a]aresample=48000[audio_out];";
  } else {
    filterComplex =
      "anullsrc=channel_layout=stereo:sample_rate=48000[audio_out];";
  }

  // Video layout
  const firstVideoIndex = audioCount;
  if (videoCount === 2) {
    filterComplex +=
      `[${firstVideoIndex}:v]scale=640:480[left];` +
      `[${firstVideoIndex + 1}:v]scale=640:480[right];` +
      `[left][right]hstack=inputs=2[video_out]`;
  } else if (videoCount === 1) {
    filterComplex += `[${firstVideoIndex}:v]scale=1280:720[video_out]`;
  }

  return filterComplex;
}

function setupFFmpegEventHandlers(ffmpegProcess, outputDir) {
  ffmpegProcess.stdout.on("data", (data) => {
    logger.debug(`FFmpeg stdout: ${data.toString()}`);
  });

  ffmpegProcess.stderr.on("data", (data) => {
    logger.debug(`FFmpeg stderr: ${data.toString()}`);
  });

  ffmpegProcess.on("close", (code) => {
    logger.info(`FFmpeg process exited with code ${code}`);
  });

  ffmpegProcess.on("error", (err) => {
    logger.error(`FFmpeg process error: ${err.message}`);
  });
}

async function setupConsumerResumption(audioConsumers, videoConsumers, roomId) {
  setTimeout(async () => {
    try {
      const allConsumers = [...audioConsumers, ...videoConsumers];

      for (const consumer of allConsumers) {
        if (consumer.kind === "video") {
          await consumer.requestKeyFrame();
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await consumer.resume();
        logger.debug(`Resumed consumer ${consumer.id}`);
      }

      logger.info(`All consumers resumed for room ${roomId}`);

      // Setup periodic keyframe requests
      const keyframeInterval = setInterval(() => {
        videoConsumers.forEach((consumer) => consumer.requestKeyFrame());
      }, CONFIG.HLS.KEYFRAME_INTERVAL);

      // Store interval for cleanup
      const hlsProcess = hlsProcesses.get(roomId);
      if (hlsProcess) {
        hlsProcess.keyframeInterval = keyframeInterval;
      }
    } catch (error) {
      logger.error(`Error resuming consumers: ${error.message}`);
    }
  }, 3000);
}

async function cleanupHLSResources(resources) {
  const { transports, consumers, ffmpegProcess } = resources;

  if (ffmpegProcess && !ffmpegProcess.killed) {
    ffmpegProcess.kill("SIGTERM");
  }

  consumers.forEach((consumer) => {
    if (!consumer.closed) consumer.close();
  });

  transports.forEach((transport) => {
    if (!transport.closed) transport.close();
  });
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
    try {
      const transport = await router.createWebRtcTransport(CONFIG.TRANSPORT);
      const peer = getPeer(socket.id);
      peer.transports.add(transport);

      cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (error) {
      logger.error(
        `Error creating transport for ${socket.id}: ${error.message}`
      );
      cb({ error: error.message });
    }
  });

  socket.on("connectTransport", async ({ transportId, dtlsParameters }, cb) => {
    try {
      const peer = getPeer(socket.id);
      const transport = Array.from(peer.transports).find(
        (t) => t.id === transportId
      );

      if (!transport) {
        throw new Error(`Transport ${transportId} not found`);
      }

      await transport.connect({ dtlsParameters });
      cb({ success: true });
    } catch (error) {
      logger.error(
        `Error connecting transport for ${socket.id}: ${error.message}`
      );
      cb({ error: error.message });
    }
  });

  socket.on("produce", async ({ transportId, kind, rtpParameters }, cb) => {
    try {
      const peer = getPeer(socket.id);
      const transport = Array.from(peer.transports).find(
        (t) => t.id === transportId
      );

      if (!transport) {
        throw new Error(`Transport ${transportId} not found`);
      }

      const producer = await transport.produce({ kind, rtpParameters });
      peer.producers.add(producer);

      // Store producer in room data if in a room
      const roomId = peer.roomId;
      if (roomId) {
        const room = rooms.get(roomId);
        if (room) {
          if (!room.producers.has(socket.id)) {
            room.producers.set(socket.id, new Set());
          }
          room.producers.get(socket.id).add(producer);

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
    } catch (error) {
      logger.error(`Error producing for ${socket.id}: ${error.message}`);
      cb({ error: error.message });
    }
  });

  socket.on("getProducers", (cb) => {
    try {
      const peer = getPeer(socket.id);
      const roomId = peer.roomId;

      if (roomId && rooms.has(roomId)) {
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

        cb({ producers: producersList });
      } else {
        logger.debug(`Peer ${socket.id} not in any room, no producers to get`);
        cb({ producers: [] });
      }
    } catch (error) {
      logger.error(
        `Error getting producers for ${socket.id}: ${error.message}`
      );
      cb({ error: error.message });
    }
  });

  socket.on(
    "consume",
    async ({ producerId, rtpCapabilities, transportId }, cb) => {
      try {
        const peer = getPeer(socket.id);
        const transport = Array.from(peer.transports).find(
          (t) => t.id === transportId
        );

        if (!transport) {
          throw new Error(`Transport ${transportId} not found`);
        }

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });

        peer.consumers.add(consumer);

        // Store consumer in room data if in a room
        const roomId = peer.roomId;
        if (roomId) {
          const room = rooms.get(roomId);
          if (room) {
            if (!room.consumers.has(socket.id)) {
              room.consumers.set(socket.id, new Set());
            }
            room.consumers.get(socket.id).add(consumer);
          }
        }

        cb({
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (error) {
        logger.error(`Consume error for ${socket.id}: ${error.message}`);
        cb({ error: error.message });
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

  socket.on("disconnect", async () => {
    logger.info(`Peer disconnected: ${socket.id}`);

    try {
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
              try {
                await stopHLS(roomId);
                logger.info(`HLS stopped for empty room ${roomId}`);
              } catch (error) {
                logger.error(
                  `Error stopping HLS for room ${roomId}: ${error.message}`
                );
              }
            }
            rooms.delete(roomId);
            logger.info(`Room ${roomId} deleted as it's empty`);
          }
        }

        // Clean up peer resources
        peer.transports.forEach((transport) => {
          if (!transport.closed) transport.close();
        });
        peer.producers.forEach((producer) => {
          if (!producer.closed) producer.close();
        });
        peer.consumers.forEach((consumer) => {
          if (!consumer.closed) consumer.close();
        });
      }

      peers.delete(socket.id);
    } catch (error) {
      logger.error(
        `Error during disconnect cleanup for ${socket.id}: ${error.message}`
      );
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
