// Represents the persistent storage state for a single trade execution
// Uses string types for decimals (prices/pnl) to preserve precision during database I/O
export interface TradeRow {
  trade_id: string;
  user_id: string;
  session_id: string;
  asset: string;
  asset_class: "equity" | "crypto" | "forex";
  direction: "long" | "short";
  entry_price: string;
  exit_price: string | null;
  quantity: string;
  entry_at: string;
  exit_at: string | null;
  status: "open" | "closed" | "cancelled";
  plan_adherence: number | null;
  emotional_state: "calm" | "anxious" | "greedy" | "fearful" | "neutral" | null;
  entry_rationale: string | null;
  outcome: "win" | "loss" | null;
  pnl: string | null;
  revenge_flag: boolean;
  event_emitted: boolean;
  created_at: string;
  updated_at: string;
}

// Data Transfer Object (DTO) for capturing trade events from the frontend
// Enforces number types for runtime calculations before persistence
export interface TradeInput {
  tradeId: string;
  userId: string;
  sessionId: string;
  asset: string;
  assetClass: "equity" | "crypto" | "forex";
  direction: "long" | "short";
  entryPrice: number;
  exitPrice?: number | null;
  quantity: number;
  entryAt: string;
  exitAt?: string | null;
  status: "open" | "closed" | "cancelled";
  planAdherence?: number | null;
  emotionalState?: "calm" | "anxious" | "greedy" | "fearful" | "neutral" | null;
  entryRationale?: string | null;
}
