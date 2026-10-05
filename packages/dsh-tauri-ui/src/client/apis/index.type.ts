export type SessionResumeResponse = {
  ok?: boolean;
  error?: string;
  refusal?: {
    message: string;
    code: string;
    status: number;
  };
};
export type UngroupedResponse = {
  cwd?: string;
  error?: string;
};

export interface PostSessionResumeBody {
  sessionId?: string;
}
