export declare function stamp(now?: Date): string;
export declare function consumeLines(buffer: string, chunk: string): {
    lines: string[];
    rest: string;
};
export declare function formatRawLine(line: string, now?: Date): string;
export declare function formatPiEvent(event: Record<string, unknown>, now?: Date): string[];
