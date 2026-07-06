export type { CaptureExceptionPayload, IdentifyPayload, TrackerAdapter, TrackPayload } from "./base"
export { FirebaseAdapter, type FirebaseAdapterConfig } from "./firebase"
export {
  createPostHogBeforeSend,
  POSTHOG_SAMPLE_RATE,
  PostHogAdapter,
  type PostHogAdapterConfig,
} from "./posthog"
export { ProxyAdapter } from "./proxy"
