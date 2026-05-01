export interface InnerCommand {
  executable: string;
  args: string[];
  env: Record<string, string>;
}
