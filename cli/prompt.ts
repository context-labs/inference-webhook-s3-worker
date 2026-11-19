import { confirm, input, password, select } from "@inquirer/prompts";

/** Questions the CLI asks in a terminal. Commands get `null` when they must not ask. */
export interface Prompter {
  input(message: string, options?: { default?: string; validate?: (value: string) => string | true }): Promise<string>;
  password(message: string): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  select<T extends string>(message: string, choices: Array<{ name: string; value: T }>): Promise<T>;
}

export const terminalPrompter: Prompter = {
  input: (message, options = {}) => input({ message, default: options.default, validate: options.validate }),
  password: (message) => password({ message, mask: "*", validate: (value) => value.length > 0 || "Required" }),
  confirm: (message, defaultValue) => confirm({ message, default: defaultValue }),
  select: (message, choices) => select({ message, choices }),
};
