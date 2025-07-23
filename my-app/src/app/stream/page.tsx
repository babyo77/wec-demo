"use client";
import { useEffect, useRef, useState } from "react";
import { socket } from "@/app/lib/socket";
import * as mediasoupClient from "mediasoup-client";

const ROOM_ID = "room1";

const StreamPage = () => {
  const [joined, setJoined] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const deviceRef = useRef<mediasoupClient.types.Device | null>(null);
  const sendTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const recvTransportRef = useRef<mediasoupClient.types.Transport | null>(null);

  useEffect(() => {
    const start = async () => {
      socket.emit("joinRoom", { roomId: ROOM_ID }, async (res: any) => {
        if (res.error) return alert(res.error);

        const rtpCapabilities = await new Promise<any>((resolve) =>
          socket.emit("getRtpCapabilities", resolve)
        );

        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        deviceRef.current = device;

        // === SEND TRANSPORT ===
        const sendTransportParams = await new Promise<any>((resolve) =>
          socket.emit("createTransport", resolve)
        );

        const sendTransport = device.createSendTransport(sendTransportParams);
        sendTransportRef.current = sendTransport;

        sendTransport.on("connect", ({ dtlsParameters }, cb) => {
          socket.emit(
            "connectTransport",
            { transportId: sendTransport.id, dtlsParameters },
            cb
          );
        });

        sendTransport.on("produce", ({ kind, rtpParameters }, cb) => {
          socket.emit(
            "produce",
            { transportId: sendTransport.id, kind, rtpParameters },
            ({ id }: { id: string }) => cb({ id })
          );
        });

        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });

        localVideoRef.current!.srcObject = stream;

        for (const track of stream.getTracks()) {
          await sendTransport.produce({ track });
        }

        // === RECEIVE TRANSPORT ===
        const recvTransportParams = await new Promise<any>((resolve) =>
          socket.emit("createTransport", resolve)
        );

        const recvTransport = device.createRecvTransport(recvTransportParams);
        recvTransportRef.current = recvTransport;

        recvTransport.on("connect", ({ dtlsParameters }, cb) => {
          socket.emit(
            "connectTransport",
            { transportId: recvTransport.id, dtlsParameters },
            cb
          );
        });

        // Get all existing producers - FIX: Access the producers array from the response object
        socket.emit("getProducers", async (response: any) => {
          // Handle both error case and success case
          if (response.error) {
            console.error("Error getting producers:", response.error);
            return;
          }

          // The server returns { producers: [...] }, so we need to access the producers property
          const producers = response.producers || [];

          for (const producer of producers) {
            await consumeRemote(producer.producerId, producer.kind);
          }
        });

        // Listen for future producers
        socket.on("newProducer", async ({ producerId, kind }) => {
          await consumeRemote(producerId, kind);
        });

        const consumeRemote = async (
          producerId: string,
          _kind: mediasoupClient.types.MediaKind
        ) => {
          try {
            const consumerParams = await new Promise<any>((resolve, reject) =>
              socket.emit(
                "consume",
                {
                  producerId,
                  rtpCapabilities: device.rtpCapabilities,
                  transportId: recvTransportRef.current!.id,
                },
                (response: any) => {
                  if (response.error) {
                    reject(new Error(response.error));
                  } else {
                    resolve(response);
                  }
                }
              )
            );

            const consumer = await recvTransportRef.current!.consume({
              id: consumerParams.id,
              producerId: consumerParams.producerId,
              kind: consumerParams.kind,
              rtpParameters: consumerParams.rtpParameters,
            });

            const stream = new MediaStream([consumer.track]);

            // Handle multiple remote streams better
            if (remoteVideoRef.current) {
              const existingStream = remoteVideoRef.current
                .srcObject as MediaStream;
              if (existingStream) {
                // Add new track to existing stream
                existingStream.addTrack(consumer.track);
              } else {
                // Set new stream
                remoteVideoRef.current.srcObject = stream;
              }
              remoteVideoRef.current.play().catch(console.error);
            }
          } catch (error) {
            console.error("Error consuming remote stream:", error);
          }
        };

        setJoined(true);
      });
    };

    start().catch(console.error);
  }, []);

  const handleStartHLS = () => {
    socket.emit("startHLS", (res: any) => {
      if (res.error) return alert(res.error);
      alert("HLS started");
    });
  };

  const handleStopHLS = () => {
    socket.emit("stopHLS", (res: any) => {
      if (res.error) return alert(res.error);
      alert("HLS stopped");
    });
  };

  return (
    <div className="p-8">
      <h1 className="text-xl font-bold">/stream</h1>

      <div className="flex gap-4 mt-4">
        <div className="w-1/2">
          <p className="font-semibold">Local Stream</p>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full border rounded"
          />
        </div>
        <div className="w-1/2">
          <p className="font-semibold">Remote Stream</p>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="w-full border rounded"
          />
        </div>
      </div>

      {joined && (
        <div className="space-x-4 mt-4">
          <button
            onClick={handleStartHLS}
            className="px-4 py-2 bg-green-600 text-white rounded"
          >
            Start HLS
          </button>
          <button
            onClick={handleStopHLS}
            className="px-4 py-2 bg-red-600 text-white rounded"
          >
            Stop HLS
          </button>
        </div>
      )}
    </div>
  );
};

export default StreamPage;
