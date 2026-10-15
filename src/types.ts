export type Page = 'tasks' | 'bookings' | 'notifications' | 'accounts' | 'settings';
export type Source = 'live' | 'demo';
export type BrowserChannel = 'chrome' | 'msedge';
export type BrowserIntegration = 'extension' | 'dedicated';
export type RecordKind = 'events' | 'notifications' | 'bookings' | 'all';
export type TaskStatus = 'paused' | 'active' | 'auth_required' | 'backoff' | 'user_action_required' | 'awaiting_confirmation' | 'confirmed' | 'expired';
export type Mode = 'notify' | 'assist' | 'auto';
export interface Slot { date: string; time: string; partySize: number; seatType?: string; label?: string }
export interface VerificationProgress {
  phase?: string; submitted?: boolean; nextVerificationAt?: string | null; verificationCount?: number;
  lastVerifiedAt?: string | null; lastVerificationMessage?: string | null; verificationFailureCount?: number;
}
export interface Task extends VerificationProgress {
  id: string; accountId: string; accountLabel?: string; restaurantName: string; restaurantUrl: string; dates: string[];
  partySize: number; timeStart: string; timeEnd: string; mode: Mode; groupId?: string;
  pollIntervalMs: number; status: TaskStatus; source: Source;
  createdAt: string; updatedAt: string; checkCount: number; lastCheckedAt?: string;
  lastCheckStartedAt?: string | null; lastCheckDurationMs?: number | null; effectiveIntervalMs?: number | null;
  lastMessage?: string; slots?: Slot[]; nextCheckAt?: string; lastError?: string;
}
export interface RunEvent { id: string; accountId: string; accountLabel?: string; taskId?: string; source: Source; type: string; level: string; message: string; slot?: Slot; createdAt: string }
export interface Booking extends VerificationProgress {
  id: string; accountId: string; accountLabel?: string; taskId: string; source: Source; restaurantName: string; restaurantUrl: string;
  slot?: Slot; status: 'submitting' | 'pending_restaurant' | 'confirmed' | 'rejected' | 'outcome_unknown' | 'user_action_required';
  message?: string; reservationId?: string; createdAt: string; updatedAt: string;
}
export interface AppNotification {
  id: string; accountId: string; accountLabel?: string; eventId?: string; taskId?: string; source: Source; channel: 'in_app' | 'webhook';
  status: 'visible' | 'queued' | 'accepted' | 'failed'; message: string; slot?: Slot;
  attempts: number; createdAt: string; lastError?: string; acceptedAt?: string; eventType?: string; restaurantUrl?: string | null;
}
export interface RestaurantInfo {
  restaurantUrl: string; restaurantName: string; description?: string; address?: string;
  category?: string; priceSummary?: string; rating?: number; reviewCount?: number;
  phone?: string; imageUrl?: string; bookingNotes: string[];
  requiredFields: Array<{ label: string; required: boolean }>;
  defaults: { partySize: number; timeStart: string; timeEnd: string };
  verifiedAt: string; source: 'catchtable_public';
}
export interface SessionState {
  status?: string; connected?: boolean; authenticated?: boolean; message?: string; lastCheckedAt?: string;
  browserName?: string; browserChannel?: BrowserChannel; profileLabel?: string; browserIntegration?: BrowserIntegration;
  browserMode?: 'extension' | 'manual' | 'controlled'; [key: string]: unknown;
}
export interface ExtensionState { connected: boolean; status: string; message: string; clientName?: string }
export interface EngineState {
  running?: boolean; paused?: boolean; globalPaused?: boolean; busy?: boolean; accountWriteBlocked?: boolean;
  lastTickAt?: string; currentDate?: string; currentTaskId?: string | null; queuedActions?: number;
  processMemoryMB?: number; systemFreeMemoryMB?: number; connectedAccounts?: number; authenticatedAccounts?: number;
}
export interface AccountSettings {
  bookingName: string; bookingPhoneCountryCode: string; bookingPhoneNumber: string; bookingPhoneAutoFill: boolean;
  pollIntervalMs: number; browserIntegration: BrowserIntegration; browserChannel: BrowserChannel; enginePaused: boolean;
}
export interface Account {
  id: string; label: string; enabled: boolean; taskCount: number; settings: AccountSettings;
  session: SessionState; extension?: ExtensionState; engine: EngineState;
}
export interface AccountFormValues {
  label: string; bookingName: string; bookingPhoneCountryCode: string; bookingPhoneNumber: string; bookingPhoneAutoFill: boolean;
}
export interface AppState {
  accounts: Account[];
  tasks: Task[]; events: RunEvent[]; bookings: Booking[]; notifications: AppNotification[];
  settings: { pollIntervalMs: number; webhookUrl?: string; browserChannel?: BrowserChannel; browserIntegration?: BrowserIntegration };
  session: SessionState;
  extension?: ExtensionState;
  engine: EngineState;
  stats: { totalTasks: number; activeTasks: number; availableEvents: number; confirmedBookings: number; demoBookings: number; totalChecks: number; pendingNotifications: number };
}
export interface NewTask {
  accountId: string; restaurantName: string; restaurantUrl: string; dates: string[]; partySize: number;
  timeStart: string; timeEnd: string; mode: Mode; groupId?: string;
  pollIntervalMs: number; autoConsent?: boolean;
}
