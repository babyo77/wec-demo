"use client";
import { useEffect, useRef } from "react";
import Hls from "hls.js";

const WatchPage = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const roomId = "room1";

  useEffect(() => {
    const video = videoRef.current;
    const hls = new Hls();

    hls.config.liveSyncDuration = 1.5;
    hls.config.liveMaxLatencyDuration = 1;
    hls.config.lowLatencyMode = true;

    hls.loadSource(`http://localhost:3001/hls/${roomId}/index.m3u8`);
    hls.attachMedia(video!);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video?.play();
    });

    return () => hls.destroy();
  }, []);

  return (
    <div className="p-8">
      <h1 className="text-xl font-bold">/watch</h1>
      <video
        height={720}
        width={1080}
        ref={videoRef}
        controls
        muted
        className=" mt-4 rounded border"
      />
    </div>
  );
};

export default WatchPage;
