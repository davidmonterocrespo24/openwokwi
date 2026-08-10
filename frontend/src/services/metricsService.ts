import axios from 'axios';
import { getApiBase } from '../lib/apiBase';

const api = axios.create({ withCredentials: true });
api.interceptors.request.use((config) => {
  config.baseURL = getApiBase();
  return config;
});

// ── Client-side tracking ─────────────────────────────────────────────────────

export interface RunEventPayload {
  project_id?: string | null;
  board_fqbn?: string | null;
  /** Editor BoardKind — disambiguates boards that share an FQBN (analytics). */
  board_kind?: string | null;
  /** Gallery example the workspace was loaded from (analytics). */
  example_id?: string | null;
  /** Which engine took this run — 'instant' (browser) or 'linux' (guest).
   *  Absent for boards where the question doesn't apply. */
  engine?: 'instant' | 'linux' | null;
}

export async function reportRunEvent(payload: RunEventPayload): Promise<void> {
  // Best-effort fire-and-forget.
  try {
    await api.post('/metrics/run', payload);
  } catch {
    // Telemetry must never break the user flow.
  }
}

// ── Admin dashboard ──────────────────────────────────────────────────────────

export interface OverviewResponse {
  total_users: number;
  total_projects: number;
  public_projects: number;
  private_projects: number;
  total_compiles: number;
  total_compile_errors: number;
  total_runs: number;
  compile_success_rate: number;
  dau: number;
  wau: number;
  mau: number;
  new_users_30d: number;
  new_projects_30d: number;
}

export interface TimeseriesPoint {
  bucket: string;
  value: number;
}

export interface TimeseriesResponse {
  metric: string;
  bucket: string;
  range_days: number;
  points: TimeseriesPoint[];
}

export interface BoardBreakdown {
  board_family: string | null;
  board_fqbn: string | null;
  compile_count: number;
  compile_error_count: number;
  run_count: number;
  distinct_users: number;
  distinct_projects: number;
}

export interface BoardsResponse {
  families: BoardBreakdown[];
  fqbns: BoardBreakdown[];
}

export interface BoardDiversityBucket {
  bucket: string;
  user_count: number;
}

export interface BoardDiversityResponse {
  buckets: BoardDiversityBucket[];
  total_users_with_compiles: number;
}

export interface TopUserEntry {
  user_id: string;
  username: string;
  value: number;
}

export interface TopProjectEntry {
  project_id: string;
  project_name: string;
  owner_username: string;
  value: number;
}

export interface UserMetricsResponse {
  user_id: string;
  username: string;
  total_compiles: number;
  total_compile_errors: number;
  total_runs: number;
  last_active_at: string | null;
  boards_used: string[];
  fqbns_used: string[];
  project_count: number;
  timeseries: TimeseriesPoint[];
}

export interface CountryEntry {
  country: string | null;
  user_count: number;
  signup_count: number;
  compile_count: number;
  run_count: number;
  distinct_users_active: number;
}

export interface CountriesResponse {
  range_days: number;
  entries: CountryEntry[];
}

export async function adminGetCountries(rangeDays = 90): Promise<CountriesResponse> {
  const { data } = await api.get<CountriesResponse>('/admin/metrics/countries', {
    params: { range_days: rangeDays },
  });
  return data;
}

export interface ProjectMetricsResponse {
  project_id: string;
  project_name: string;
  owner_username: string;
  compile_count: number;
  compile_error_count: number;
  run_count: number;
  update_count: number;
  last_compiled_at: string | null;
  last_run_at: string | null;
  timeseries: TimeseriesPoint[];
}

export async function adminGetOverview(): Promise<OverviewResponse> {
  const { data } = await api.get<OverviewResponse>('/admin/metrics/overview');
  return data;
}

export async function adminGetTimeseries(
  metric: 'compile' | 'compile_error' | 'run' | 'save' | 'create' | 'project_open',
  rangeDays = 30,
  bucket: 'hour' | 'day' | 'week' = 'day',
): Promise<TimeseriesResponse> {
  const { data } = await api.get<TimeseriesResponse>('/admin/metrics/timeseries', {
    params: { metric, range_days: rangeDays, bucket },
  });
  return data;
}

export async function adminGetBoards(rangeDays = 90): Promise<BoardsResponse> {
  const { data } = await api.get<BoardsResponse>('/admin/metrics/boards', {
    params: { range_days: rangeDays },
  });
  return data;
}

export async function adminGetBoardDiversity(): Promise<BoardDiversityResponse> {
  const { data } = await api.get<BoardDiversityResponse>('/admin/metrics/board-diversity');
  return data;
}

export async function adminGetTopUsers(
  metric: 'compiles' | 'runs' = 'compiles',
  limit = 20,
): Promise<TopUserEntry[]> {
  const { data } = await api.get<TopUserEntry[]>('/admin/metrics/top-users', {
    params: { metric, limit },
  });
  return data;
}

export async function adminGetTopProjects(
  metric: 'compiles' | 'runs' | 'updates' = 'compiles',
  limit = 20,
): Promise<TopProjectEntry[]> {
  const { data } = await api.get<TopProjectEntry[]>('/admin/metrics/top-projects', {
    params: { metric, limit },
  });
  return data;
}

export async function adminGetUserMetrics(
  userId: string,
  rangeDays = 30,
): Promise<UserMetricsResponse> {
  const { data } = await api.get<UserMetricsResponse>(`/admin/metrics/users/${userId}`, {
    params: { range_days: rangeDays },
  });
  return data;
}

export interface DailyProjectActivity {
  date: string;
  project_id: string | null;
  project_name: string | null;
  compiles: number;
  compile_errors: number;
  runs: number;
  saves: number;
}

export interface DailyTotals {
  date: string;
  compiles: number;
  compile_errors: number;
  runs: number;
  saves: number;
  distinct_projects: number;
}

export interface UserDailyActivityResponse {
  user_id: string;
  username: string;
  range_days: number;
  entries: DailyProjectActivity[];
  daily_totals: DailyTotals[];
}

export async function adminGetUserActivity(
  userId: string,
  rangeDays = 30,
): Promise<UserDailyActivityResponse> {
  const { data } = await api.get<UserDailyActivityResponse>(
    `/admin/metrics/users/${userId}/activity`,
    { params: { range_days: rangeDays } },
  );
  return data;
}

export async function adminGetProjectMetrics(
  projectId: string,
  rangeDays = 30,
): Promise<ProjectMetricsResponse> {
  const { data } = await api.get<ProjectMetricsResponse>(`/admin/metrics/projects/${projectId}`, {
    params: { range_days: rangeDays },
  });
  return data;
}
