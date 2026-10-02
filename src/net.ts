import { joinRoom, selfId, type Room } from "trystero";

export type CastMsg = { s: string; x: number };

export interface NetEvents {
  onPeerJoin(peerId: string): void;
  onPeerLeave(peerId: string): void;
  onCast(msg: CastMsg, peerId: string): void;
  onBlocked(spellId: string): void; // my projectile was blocked by opponent's shield
  onHp(hp: number): void; // authoritative opponent HP
  onKo(): void;
  onRematch(): void; // peer pressed "rematch"
  onPeerStream(stream: MediaStream, peerId: string): void;
}

export class Session {
  private room: Room;
  private stream: MediaStream | null = null;
  readonly id = selfId;

  constructor(code: string, events: NetEvents) {
    this.room = joinRoom({ appId: "hand-duel-v1" }, code);

    const cast = this.room.makeAction<CastMsg>("cast");
    const blocked = this.room.makeAction<string>("block");
    const hp = this.room.makeAction<number>("hp");
    const ko = this.room.makeAction<string>("ko");
    const rematch = this.room.makeAction<string>("rematch");

    cast.onMessage = (msg, ctx) => events.onCast(msg, ctx.peerId);
    blocked.onMessage = (spellId) => events.onBlocked(spellId);
    hp.onMessage = (v) => events.onHp(v);
    ko.onMessage = () => events.onKo();
    rematch.onMessage = () => events.onRematch();

    this.room.onPeerJoin = (id) => {
      events.onPeerJoin(id);
      // re-announce our camera stream to the newly joined peer
      if (this.stream) this.streamVideo(this.stream);
    };
    this.room.onPeerLeave = (id) => events.onPeerLeave(id);
    this.room.onPeerStream = (stream, peerId) => events.onPeerStream(stream, peerId);

    this.sendCast = (m) => void cast.send(m).catch(() => {});
    this.sendBlocked = (s) => void blocked.send(s).catch(() => {});
    this.sendHp = (v) => void hp.send(v).catch(() => {});
    this.sendKo = () => void ko.send("").catch(() => {});
    this.sendRematch = () => void rematch.send("").catch(() => {});
  }

  sendCast: (msg: CastMsg) => void;
  sendBlocked: (spellId: string) => void;
  sendHp: (hp: number) => void;
  sendKo: () => void;
  sendRematch: () => void;

  /** Publish our camera stream to peers (re-called automatically for late joiners). */
  streamVideo(stream: MediaStream): void {
    this.stream = stream;
    try {
      void this.room.addStream(stream);
    } catch (err) {
      console.warn("addStream failed", err);
    }
  }

  leave(): void {
    void this.room.leave();
  }
}
