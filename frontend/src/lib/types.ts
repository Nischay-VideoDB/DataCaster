export type EventType =
  | "goal" | "shot_on_target" | "shot_off_target" | "save" | "corner"
  | "free_kick" | "yellow_card" | "red_card" | "foul" | "throw_in"
  | "penalty" | "kick_off" | "audio_signal";

export type EventSource = "visual" | "alert" | "audio";

export interface DataCasterEvent {
  id: number;
  unix_ts: number;
  event_type: EventType | string;
  confidence: number | null;
  team: string | null;
  summary: string | null;
  raw_json: string | null;
  source: EventSource | string;
}

export interface CommentaryItem {
  id: number;
  event_id: number;
  text: string | null;
  audio_url: string | null;
  voice_style: string | null;
  created_at: number | null;
  event_type?: string | null;
  summary?: string | null;
  event_ts?: number | null;
}

export interface SearchShot {
  rtstream_id: string | null;
  rtstream_name: string | null;
  start: number | null;
  end: number | null;
  text: string | null;
  score: number | null;
  stream_url: string | null;
}

export type ContentType = "football" | "describe";

export interface PipelineState {
  started_at: number | null;
  starting_at: number | null;
  source_type: string | null;
  source: string | null;
  content_type: ContentType;
  rtstream_url: string | null;
  rtstream_id: string | null;
  sandbox_id: string | null;
  ws_id: string | null;
  visual_index_id: string | null;
  audio_index_id: string | null;
  live_stream_url: string | null;
  live_player_url: string | null;
  // VOD path (pre-recorded video). Mutually exclusive with rtstream_id.
  video_id: string | null;
  vod_scene_index_id: string | null;
  vod_total_scenes: number | null;
  vod_indexed_scenes: number | null;
  /** Source video runtime in seconds. Used to project an indexing ETA
   *  (total expected windows ≈ video_length_s / 6). Null until the
   *  upload + transcode finishes. */
  video_length_s: number | null;
  /** Set to "spoken_word" once `video.index_spoken_words(force=True)`
   *  has run. The Search panel uses this to enable the transcript tab
   *  on VOD sources. */
  transcript_index_id: string | null;
  prompt_mode: string | null;
}

export interface BusEventMessage {
  type: "event";
  event: DataCasterEvent;
}
export interface BusCommentaryMessage {
  type: "commentary";
  event_id: number;
  commentary_id: number;
  text: string;
  audio_url: string | null;
  style: string;
}
export interface BusTranscriptMessage {
  type: "transcript";
  ts: number;
  text: string;
}
// Lifecycle messages broadcast by the backend bus when the pipeline is
// stopped / events are wiped. The UI listens so it can clear the local
// React state without waiting for a /api/health poll to confirm idle.
export interface BusSessionEndedMessage {
  type: "session_ended";
}
export interface BusResyncMessage {
  type: "resync";
  video_id: string;
  cleared: number;
}
export interface BusClearedMessage {
  type: "cleared";
  scope: "events" | "commentary";
}
/** VOD scene-poller progress beacon. Emitted ~every 5s while the VOD
 *  pipeline is active. `indexed` is the total scene-windows VideoDB has
 *  produced so far; `new_in_batch` is the delta since the previous poll. */
export interface BusVodProgressMessage {
  type: "vod_progress";
  indexed: number;
  new_in_batch: number;
}
export type BusMessage =
  | BusEventMessage
  | BusCommentaryMessage
  | BusTranscriptMessage
  | BusSessionEndedMessage
  | BusResyncMessage
  | BusClearedMessage
  | BusVodProgressMessage;

export interface AskCitation {
  shot_idx: number;
  t: number;
}
export interface AskAnswer {
  query: string;
  answer: string;
  evidence: SearchShot[];
}
