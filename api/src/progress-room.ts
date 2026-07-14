import { DurableObject } from "cloudflare:workers";
import { createProgressMessage, isTerminalAnalysisState, type AnalysisProgressMessage } from "./progress-room-protocol";

export class AnalysisProgressRoom extends DurableObject<Env> {
  async seed(analysis: Parameters<typeof createProgressMessage>[0]): Promise<void> {
    const latest = await this.ctx.storage.get<AnalysisProgressMessage>("latest");
    if (!latest) await this.ctx.storage.put("latest", createProgressMessage(analysis, "snapshot"));
  }

  async publish(analysis: Parameters<typeof createProgressMessage>[0], type: AnalysisProgressMessage["type"] = "updated"): Promise<void> {
    const message = createProgressMessage(analysis, type);
    await this.ctx.storage.put("latest", message);
    const encoded = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      socket.send(encoded);
      if (isTerminalAnalysisState(analysis.state)) socket.close(1000, analysis.state);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const latest = await this.ctx.storage.get<AnalysisProgressMessage>("latest");
    if (latest) pair[1].send(JSON.stringify({ ...latest, type: "snapshot" }));
    if (latest && isTerminalAnalysisState(latest.analysis.state)) pair[1].close(1000, latest.analysis.state);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
