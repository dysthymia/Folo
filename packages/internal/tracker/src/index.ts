import { improvedTrackManager } from "./track-manager"
import { TrackerPoints } from "./tracker-points"

export const setFirebaseTracker = improvedTrackManager.setFirebaseTracker.bind(improvedTrackManager)
export const setPostHogTracker = improvedTrackManager.setPostHogTracker.bind(improvedTrackManager)
export const setProxyTracker = improvedTrackManager.setProxyTracker.bind(improvedTrackManager)

export const tracker = new TrackerPoints()

export {
  type CaptureExceptionPayload,
  createPostHogBeforeSend,
  FirebaseAdapter,
  type FirebaseAdapterConfig,
  type IdentifyPayload,
  POSTHOG_SAMPLE_RATE,
  PostHogAdapter,
  type PostHogAdapterConfig,
  ProxyAdapter,
  type TrackerAdapter,
  type TrackPayload,
} from "./adapters"
export { TrackerMapper } from "./enums"
export { TrackerManager, type TrackerManagerConfig } from "./manager"
export { improvedTrackManager, trackManager } from "./track-manager"
export { type AllTrackers, TrackerPoints } from "./tracker-points"
