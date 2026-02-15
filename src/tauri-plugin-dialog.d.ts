declare module "@tauri-apps/plugin-dialog" {
  export type FilePath = string;
  export type OpenOptions = {
    multiple?: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
  };
  export function open(options?: OpenOptions): Promise<FilePath | FilePath[] | null>;
}
