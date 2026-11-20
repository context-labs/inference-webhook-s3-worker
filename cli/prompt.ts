import { confirm, input, password, select } from "@inquirer/prompts";

/** Questions the CLI asks in a terminal. Commands get `null` when they must not ask. */
export interface Prompter {
  input(message: string, options?: { default?: string; validate?: (value: string) => string | true }): Promise<string>;
  /** Masked input. Empty answers are refused unless `optional` is set. */
  password(message: string, options?: { optional?: boolean }): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  select<T extends string>(message: string, choices: Array<{ name: string; value: T }>): Promise<T>;
}

export const terminalPrompter: Prompter = {
  input: (message, options = {}) => input({ message, default: options.default, validate: options.validate }),
  password: (message, options = {}) =>
    password({ message, mask: "*", validate: (value) => options.optional || value.length > 0 || "Required" }),
  confirm: (message, defaultValue) => confirm({ message, default: defaultValue }),
  select: (message, choices) => select({ message, choices }),
};
