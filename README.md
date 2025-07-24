

# WebRTC Demo with MediaSoup and HLS Streaming

A real-time communication application built with WebRTC, MediaSoup, and HLS streaming capabilities using Next.js and Node.js.

## 🎥 Demo Video

https://github.com/user-attachments/assets/c2977733-31a7-4e85-a012-bcb101984cd1

## 🏗️ System Architecture

```mermaid
graph TB
    subgraph "Client Side (Next.js)"
        A[Web Browser] --> B[React Components]
        B --> C[Socket.io Client]
        C --> D[WebRTC API]
    end
    
    subgraph "Server Side (Node.js)"
        E[Express Server] --> F[Socket.io Server]
        F --> G[MediaSoup Router]
        G --> H[WebRTC Transports]
        H --> I[Producers/Consumers]
        
        subgraph "HLS Streaming"
            J[FFmpeg Process] --> K[HLS Segments]
            K --> L[M3U8 Playlist]
            L --> M[Static File Server]
        end
        
        I --> J
    end
    
    subgraph "Media Flow"
        N[Audio/Video Input] --> D
        D --> H
        H --> I
        I --> O[RTP Streams]
        O --> J
        J --> P[HLS Output]
    end
    
    subgraph "Room Management"
        Q[Room State]
        R[Peer Management]
        S[Producer/Consumer Mapping]
    end
    
    A -.->|HTTP/WebSocket| E
    C -.->|Socket Events| F
    F --> Q
    F --> R
    F --> S
    M -.->|HTTP| A
```
