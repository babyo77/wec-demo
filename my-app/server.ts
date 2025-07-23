import express from "express";
import http from "http";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import path from "path";
import fs from "fs/promises";
import { spawn, ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import cors from "cors";
import { types as mediasoupTypes } from "mediasoup";

type Worker = mediasoupTypes.Worker;
type Router = mediasoupTypes.Router;
type Transport = mediasoupTypes.Transport;
type Producer = mediasoupTypes.Producer;
type Consumer = mediasoupTypes.Consumer;
type PlainTransport = mediasoupTypes.PlainTransport;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Type definitions
interface PeerData {
  transports: Set<Transport>;
  producers: Set<Producer>;
  consumers: Set<Consumer>;
  roomId: string | null;
  createdAt: number;
}

interface RoomData {
  producers: Map<string, Set<Producer>>;
  peers: Set<string>;
}

interface HLSProcessData {
  ffmpegProcess: ChildProcess;
  audioTransports: PlainTransport[];
  videoTransports: PlainTransport[];
  audioConsumers: Consumer[];
  videoConsumers: Consumer[];
  outputDir: string;
  keyframeInterval?: NodeJS.Timeout;
}

interface HLSResources {
  transports: Transport[];
  consumers: Consumer[];
  outputDir: string | null;
  ffmpegProcess: ChildProcess | null;
}

interface ConfigType {
  PORT: number;
  MEDIASOUP: {
    LOG_LEVEL: string;
    LOG_TAGS: string[];
    RTC_MIN_PORT: number;
    RTC_MAX_PORT: number;
  };
  HLS: {
    FFMPEG_HOST: string;
    AUDIO_PORT: number;
    VIDEO_BASE_PORT: number;
    SEGMENT_DURATION: number;
    PLAYLIST_SIZE: number;
    KEYFRAME_INTERVAL: number;
    GOP_SIZE: number;
  };
  TRANSPORT: {
    listenIps: Array<{
      ip: string;
      announcedIp: string | null;
    }>;
    enableUdp: boolean;
    enableTcp: boolean;
    preferUdp: boolean;
    maxIncomingBitrate: number;
  };
}

// Configuration constants
const CONFIG: ConfigType = {
  PORT: Number(process.env.PORT) || 3001,
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
    SEGMENT_DURATION: 1,
    PLAYLIST_SIZE: 3,
    KEYFRAME_INTERVAL: 1000,
    GOP_SIZE: 24,
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
let worker: Worker;
let router: Router;
const peers = new Map<string, PeerData>();
const rooms = new Map<string, RoomData>();
const hlsProcesses = new Map<string, HLSProcessData>();

// Enhanced logging with levels
const logger = {
  debug: (message: string, ...args: any[]) => {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, ...args);
    }
  },
  info: (message: string, ...args: any[]) => {
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`, ...args);
  },
  error: (message: string, ...args: any[]) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, ...args);
  },
  warn: (message: string, ...args: any[]) => {
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, ...args);
  },
};

// Legacy debug function for backward compatibility
function debug(message: string, ...args: any[]): void {
  logger.debug(message, ...args);
}

// Media codecs configuration
const MEDIA_CODECS = [
  {
    kind: "audio" as const,
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video" as const,
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
  {
    kind: "video" as const,
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

async function initializeHLSDirectory(): Promise<void> {
  try {
    await fs.access(HLS_BASE_DIR);
    logger.debug(`HLS directory already exists: ${HLS_BASE_DIR}`);
  } catch {
    await fs.mkdir(HLS_BASE_DIR, { recursive: true });
    logger.info(`Created HLS base directory: ${HLS_BASE_DIR}`);
  }
}

// Initialize MediaSoup worker and router
async function createWorker(): Promise<Router> {
  try {
    worker = await mediasoup.createWorker({
      logLevel: CONFIG.MEDIASOUP.LOG_LEVEL as any,
      logTags: CONFIG.MEDIASOUP.LOG_TAGS as any,
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
async function initializeServer(): Promise<void> {
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
function getPeer(socketId: string): PeerData {
  if (!peers.has(socketId)) {
    peers.set(socketId, {
      transports: new Set<Transport>(),
      producers: new Set<Producer>(),
      consumers: new Set<Consumer>(),
      roomId: null,
      createdAt: Date.now(),
    });
  }
  return peers.get(socketId)!;
}

function validateConsumer(consumer: Consumer): any {
  if (!consumer || !consumer.rtpParameters || !consumer.rtpParameters.codecs) {
    throw new Error("Invalid consumer or missing RTP parameters");
  }
  return consumer.rtpParameters.codecs[0];
}

// Optimized HLS SDP creation functions
function createAudioSDP(
  audioConsumer: Consumer | null,
  port: number,
  streamIndex: number = 0
): string {
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

function createVideoSDP(
  videoConsumer: Consumer | null,
  port: number,
  streamIndex: number = 0
): string {
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

async function startHLS(
  roomId: string
): Promise<{ playlistPath: string; outputDir: string }> {
  logger.info(`Starting HLS for room ${roomId}`);

  if (hlsProcesses.has(roomId)) {
    logger.warn(`HLS already started for room ${roomId}`);
    const existingProcess = hlsProcesses.get(roomId)!;
    return {
      playlistPath: `hls/${roomId}/index.m3u8`,
      outputDir: existingProcess.outputDir,
    };
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

  const resources: HLSResources = {
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

function collectProducers(room: RoomData): {
  audioProducers: Producer[];
  videoProducers: Producer[];
} {
  const audioProducers: Producer[] = [];
  const videoProducers: Producer[] = [];

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
  roomId: string,
  audioProducers: Producer[],
  videoProducers: Producer[],
  resources: HLSResources
): Promise<{ playlistPath: string; outputDir: string }> {
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
  const hlsData: HLSProcessData = {
    ffmpegProcess,
    audioTransports: resources.transports.filter(
      (_, i) => i < audioConsumers.length
    ) as PlainTransport[],
    videoTransports: resources.transports.filter(
      (_, i) => i >= audioConsumers.length
    ) as PlainTransport[],
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

async function setupOutputDirectory(outputDir: string): Promise<void> {
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
  audioProducers: Producer[],
  videoProducers: Producer[],
  resources: HLSResources
): Promise<{ audioConsumers: Consumer[]; videoConsumers: Consumer[] }> {
  const maxStreams = 2;
  const audioConsumers: Consumer[] = [];
  const videoConsumers: Consumer[] = [];

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

async function createPlainTransportAndConsumer(
  producer: Producer,
  port: number
): Promise<{ transport: PlainTransport; consumer: Consumer }> {
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

async function generateSDPFiles(
  audioConsumers: Consumer[],
  videoConsumers: Consumer[],
  outputDir: string
): Promise<void> {
  const sdpPromises: Promise<void>[] = [];

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

async function startFFmpegProcess(
  audioConsumers: Consumer[],
  videoConsumers: Consumer[],
  outputDir: string
): Promise<ChildProcess> {
  const ffmpegArgs = buildFFmpegArgs(audioConsumers, videoConsumers, outputDir);

  const ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
    cwd: outputDir,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  setupFFmpegEventHandlers(ffmpegProcess, outputDir);
  return ffmpegProcess;
}

function buildFFmpegArgs(
  audioConsumers: Consumer[],
  videoConsumers: Consumer[],
  outputDir: string
): string[] {
  const ffmpegArgs = [
    "-loglevel",
    "error",
    "-y",

    "-fflags",
    "+genpts+discardcorrupt+nobuffer+flush_packets",
    "-flags",
    "+low_delay",
    "-avoid_negative_ts",
    "make_zero",
    "-thread_queue_size",
    "512", // Reduced from 1024
    "-protocol_whitelist",
    "file,udp,rtp,rtcp,crypto,data",

    "-re", // Read input at native frame rate
    "-probesize",
    "32", // Minimal probe size
    "-analyzeduration",
    "0", // No analysis delay
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
      "-thread_queue_size",
      "512",
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
      "-thread_queue_size",
      "512",
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
    // Audio encoding - optimized for low latency
    "-c:a",
    "aac",
    "-b:a",
    "128k", // Reduced bitrate for faster encoding
    "-ar",
    "48000",
    "-ac",
    "2",
    "-profile:a",
    "aac_low",

    // Video encoding - ultra-low latency preset
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast", // Changed from veryfast to ultrafast
    "-tune",
    "zerolatency",
    "-profile:v",
    "baseline", // Changed from main to baseline for faster decoding
    "-level",
    "3.1", // Lower level for faster processing

    // Bitrate settings - optimized for speed
    "-b:v",
    "1000k", // Reduced from 1500k
    "-maxrate",
    "1200k", // Reduced accordingly
    "-bufsize",
    "2000k", // Reduced buffer size

    // GOP settings for minimal latency
    "-g",
    CONFIG.HLS.GOP_SIZE.toString(), // Small GOP size
    "-keyint_min",
    CONFIG.HLS.GOP_SIZE.toString(),
    "-sc_threshold",
    "0", // Disable scene change detection
    "-force_key_frames",
    "expr:gte(t,n_forced*1)", // Force keyframes every second

    // Frame rate and threading
    "-r",
    "30", // Increased from 24 to 30fps
    "-threads",
    "4", // Limit threads for faster encoding
    "-thread_type",
    "frame+slice",

    // HLS-specific ultra-low latency settings
    "-f",
    "hls",
    "-hls_time",
    CONFIG.HLS.SEGMENT_DURATION.toString(),
    "-hls_list_size",
    CONFIG.HLS.PLAYLIST_SIZE.toString(),

    // Critical low-latency HLS flags
    "-hls_flags",
    "delete_segments+append_list+discont_start+omit_endlist+independent_segments",
    "-hls_delete_threshold",
    "1",
    "-hls_segment_type",
    "mpegts",

    // Low-latency specific settings
    "-hls_init_time",
    "0", // No initial delay
    "-hls_allow_cache",
    "0", // Disable caching
    "-start_number",
    "0",
    "-hls_start_number_source",
    "epoch",

    // Output settings
    "-hls_segment_filename",
    path.join(outputDir, "segment_%d.ts"),
    "-method",
    "PUT", // Use PUT for better real-time performance

    path.join(outputDir, "index.m3u8")
  );

  return ffmpegArgs;
}

function buildFilterComplex(audioCount: number, videoCount: number): string {
  let filterComplex = "";

  // Audio mixing with minimal latency
  if (audioCount > 1) {
    filterComplex =
      "[0:a][1:a]amix=inputs=2:duration=shortest:normalize=0[audio_out];";
  } else if (audioCount === 1) {
    filterComplex = "[0:a]aresample=48000:async=1[audio_out];";
  } else {
    filterComplex =
      "anullsrc=channel_layout=stereo:sample_rate=48000[audio_out];";
  }

  // Video layout with performance optimization
  const firstVideoIndex = audioCount;
  if (videoCount === 2) {
    filterComplex +=
      `[${firstVideoIndex}:v]scale=640:480:flags=fast_bilinear[left];` +
      `[${firstVideoIndex + 1}:v]scale=640:480:flags=fast_bilinear[right];` +
      `[left][right]hstack=inputs=2:shortest=1[video_out]`;
  } else if (videoCount === 1) {
    filterComplex += `[${firstVideoIndex}:v]scale=1280:720:flags=fast_bilinear[video_out]`;
  }

  return filterComplex;
}

function setupFFmpegEventHandlers(
  ffmpegProcess: ChildProcess,
  outputDir?: string
): void {
  ffmpegProcess.stdout?.on("data", (data) => {
    logger.debug(`FFmpeg stdout: ${data.toString()}`);
  });

  ffmpegProcess.stderr?.on("data", (data) => {
    logger.debug(`FFmpeg stderr: ${data.toString()}`);
  });

  ffmpegProcess.on("close", (code) => {
    logger.info(`FFmpeg process exited with code ${code}`);
  });

  ffmpegProcess.on("error", (err) => {
    logger.error(`FFmpeg process error: ${err.message}`);
  });
}

async function setupConsumerResumption(
  audioConsumers: Consumer[],
  videoConsumers: Consumer[],
  roomId: string
): Promise<void> {
  // Reduced delay from 3000ms to 1000ms for faster startup
  setTimeout(async () => {
    try {
      const allConsumers = [...audioConsumers, ...videoConsumers];

      // Resume all consumers simultaneously instead of sequentially
      const resumePromises = allConsumers.map(async (consumer) => {
        if (consumer.kind === "video") {
          await consumer.requestKeyFrame();
        }
        await consumer.resume();
        logger.debug(`Resumed consumer ${consumer.id}`);
      });

      await Promise.all(resumePromises);
      logger.info(`All consumers resumed for room ${roomId}`);

      // More frequent keyframe requests for lower latency
      const keyframeInterval = setInterval(() => {
        videoConsumers.forEach((consumer) => {
          consumer.requestKeyFrame().catch(() => {}); // Ignore errors
        });
      }, CONFIG.HLS.KEYFRAME_INTERVAL);

      // Store interval for cleanup
      const hlsProcess = hlsProcesses.get(roomId);
      if (hlsProcess) {
        hlsProcess.keyframeInterval = keyframeInterval;
      }
    } catch (error: any) {
      logger.error(`Error resuming consumers: ${error.message}`);
    }
  }, 1000); // Reduced from 3000ms
}

async function cleanupHLSResources(resources: HLSResources): Promise<void> {
  try {
    // Close consumers
    for (const consumer of resources.consumers) {
      if (!consumer.closed) {
        consumer.close();
      }
    }

    // Close transports
    for (const transport of resources.transports) {
      if (!transport.closed) {
        transport.close();
      }
    }

    // Kill FFmpeg process
    if (resources.ffmpegProcess && !resources.ffmpegProcess.killed) {
      resources.ffmpegProcess.kill("SIGTERM");
    }

    // Clean up output directory
    if (resources.outputDir) {
      try {
        await fs.rm(resources.outputDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn(`Failed to clean up output directory: ${error}`);
      }
    }

    logger.debug("HLS resources cleaned up successfully");
  } catch (error) {
    logger.error("Error cleaning up HLS resources:", error);
  }
}

async function stopHLS(roomId: string): Promise<void> {
  logger.info(`Stopping HLS for room ${roomId}`);

  const hlsProcess = hlsProcesses.get(roomId);
  if (!hlsProcess) {
    logger.warn(`No HLS process found for room ${roomId}`);
    return;
  }

  try {
    // Clear keyframe interval
    if (hlsProcess.keyframeInterval) {
      clearInterval(hlsProcess.keyframeInterval);
    }

    // Kill FFmpeg process
    if (hlsProcess.ffmpegProcess && !hlsProcess.ffmpegProcess.killed) {
      hlsProcess.ffmpegProcess.kill("SIGTERM");
      logger.info(`FFmpeg process terminated for room ${roomId}`);
    }

    // Close consumers
    const allConsumers = [
      ...hlsProcess.audioConsumers,
      ...hlsProcess.videoConsumers,
    ];
    for (const consumer of allConsumers) {
      if (!consumer.closed) {
        consumer.close();
        logger.debug(`Closed consumer ${consumer.id}`);
      }
    }

    // Clean up output directory
    try {
      await fs.rm(hlsProcess.outputDir, { recursive: true, force: true });
      logger.debug(`Cleaned up HLS directory: ${hlsProcess.outputDir}`);
    } catch (error) {
      logger.warn(`Failed to clean up HLS directory: ${error}`);
    }

    hlsProcesses.delete(roomId);
    logger.info(`HLS stopped successfully for room ${roomId}`);
  } catch (error: any) {
    logger.error(`Error stopping HLS for room ${roomId}:`, error.message);
    throw error;
  }
}

// Socket.io event handlers
io.on("connection", (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  socket.on("ready", (callback) => {
    try {
      getPeer(socket.id);
      logger.debug(`Client ${socket.id} is ready`);
      callback({ success: true, peerId: socket.id });
    } catch (error: any) {
      logger.error(`Error in ready event: ${error.message}`);
      callback({ error: error.message });
    }
  });

  socket.on("joinRoom", (roomId: string, callback) => {
    try {
      const peer = getPeer(socket.id);
      peer.roomId = roomId;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          producers: new Map(),
          peers: new Set(),
        });
      }

      const room = rooms.get(roomId)!;
      room.peers.add(socket.id);
      socket.join(roomId);

      logger.info(`Client ${socket.id} joined room ${roomId}`);
      callback({ success: true });
    } catch (error: any) {
      logger.error(`Error joining room: ${error.message}`);
      callback({ error: error.message });
    }
  });

  socket.on("getRtpCapabilities", (callback) => {
    try {
      callback({ rtpCapabilities: router.rtpCapabilities });
    } catch (error: any) {
      logger.error(`Error getting RTP capabilities: ${error.message}`);
      callback({ error: error.message });
    }
  });

  socket.on("createTransport", async (callback) => {
    try {
      const transport = await router.createWebRtcTransport(
        CONFIG.TRANSPORT as any
      );
      const peer = getPeer(socket.id);
      peer.transports.add(transport);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (error: any) {
      logger.error(`Error creating transport: ${error.message}`);
      callback({ error: error.message });
    }
  });

  socket.on(
    "connectTransport",
    async ({ transportId, dtlsParameters }, callback) => {
      try {
        const peer = getPeer(socket.id);
        const transport = Array.from(peer.transports).find(
          (t) => t.id === transportId
        );

        if (!transport) {
          throw new Error(`Transport ${transportId} not found`);
        }

        await transport.connect({ dtlsParameters });
        callback({ success: true });
      } catch (error: any) {
        logger.error(`Error connecting transport: ${error.message}`);
        callback({ error: error.message });
      }
    }
  );

  socket.on(
    "produce",
    async (
      data: { transportId: string; kind: string; rtpParameters: any },
      callback
    ) => {
      try {
        const peer = getPeer(socket.id);
        const transport = Array.from(peer.transports).find(
          (t) => t.id === data.transportId
        );

        if (!transport) {
          throw new Error(`Transport ${data.transportId} not found`);
        }

        const producer = await transport.produce({
          kind: data.kind as "audio" | "video",
          rtpParameters: data.rtpParameters,
        });

        peer.producers.add(producer);

        // Add to room producers
        if (peer.roomId) {
          const room = rooms.get(peer.roomId);
          if (room) {
            if (!room.producers.has(socket.id)) {
              room.producers.set(socket.id, new Set());
            }
            room.producers.get(socket.id)!.add(producer);
          }
        }

        // Notify other clients in the room
        if (peer.roomId) {
          socket.to(peer.roomId).emit("newProducer", {
            producerId: producer.id,
            kind: producer.kind,
            peerId: socket.id,
          });
        }

        callback({ id: producer.id });
      } catch (error: any) {
        logger.error(`Error producing: ${error.message}`);
        callback({ error: error.message });
      }
    }
  );

  socket.on("getProducers", (callback) => {
    try {
      const peer = getPeer(socket.id);
      if (!peer.roomId) {
        return callback({ producers: [] });
      }

      const room = rooms.get(peer.roomId);
      if (!room) {
        return callback({ producers: [] });
      }

      const producers: Array<{ id: string; kind: string; peerId: string }> = [];
      for (const [peerId, peerProducers] of room.producers.entries()) {
        if (peerId !== socket.id) {
          for (const producer of peerProducers) {
            producers.push({
              id: producer.id,
              kind: producer.kind,
              peerId,
            });
          }
        }
      }

      logger.debug(
        `Found ${producers.length} producers for client ${socket.id}`
      );
      callback({ producers });
    } catch (error: any) {
      logger.error(`Error getting producers: ${error.message}`);
      callback({ error: error.message });
    }
  });

  socket.on(
    "consume",
    async (
      data: { transportId: string; producerId: string; rtpCapabilities: any },
      callback
    ) => {
      try {
        const peer = getPeer(socket.id);
        const transport = Array.from(peer.transports).find(
          (t) => t.id === data.transportId
        );

        if (!transport) {
          throw new Error(`Transport ${data.transportId} not found`);
        }

        const consumer = await transport.consume({
          producerId: data.producerId,
          rtpCapabilities: data.rtpCapabilities,
          paused: true,
        });

        peer.consumers.add(consumer);

        // Add to room consumers
        if (peer.roomId) {
          const room = rooms.get(peer.roomId);
          if (room) {
            // Room consumers tracking could be added here if needed
          }
        }

        callback({
          id: consumer.id,
          producerId: data.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (error: any) {
        logger.error(`Error consuming: ${error.message}`);
        callback({ error: error.message });
      }
    }
  );

  socket.on("startHLS", async (roomId: string, callback) => {
    try {
      const result = await startHLS(roomId);
      callback({ success: true, ...result });
    } catch (error: any) {
      logger.error(`Error starting HLS: ${error.message}`);
      callback({ error: error.message });
    }
  });

  socket.on("stopHLS", async (roomId: string, callback) => {
    try {
      await stopHLS(roomId);
      callback({ success: true });
    } catch (error: any) {
      logger.error(`Error stopping HLS: ${error.message}`);
      callback({ error: error.message });
    }
  });

  socket.on("disconnect", async () => {
    try {
      logger.info(`Client disconnected: ${socket.id}`);
      const peer = peers.get(socket.id);

      if (peer) {
        // Close all transports
        for (const transport of peer.transports) {
          if (!transport.closed) {
            transport.close();
          }
        }

        // Close all producers
        for (const producer of peer.producers) {
          if (!producer.closed) {
            producer.close();
          }
        }

        // Close all consumers
        for (const consumer of peer.consumers) {
          if (!consumer.closed) {
            consumer.close();
          }
        }

        // Remove from room
        if (peer.roomId) {
          const room = rooms.get(peer.roomId);
          if (room) {
            room.peers.delete(socket.id);
            room.producers.delete(socket.id);

            // If room is empty, clean it up
            if (room.peers.size === 0) {
              rooms.delete(peer.roomId);
              logger.info(`Room ${peer.roomId} deleted (empty)`);
            }
          }
        }

        peers.delete(socket.id);
      }
    } catch (error: any) {
      logger.error(`Error during disconnect cleanup: ${error.message}`);
    }
  });
});

server.listen(CONFIG.PORT, () => {
  logger.info(`Server running on http://localhost:${CONFIG.PORT}`);
});
