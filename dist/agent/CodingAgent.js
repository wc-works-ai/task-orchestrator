export function positiveInt(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
export function countOccurrences(haystack, needle) {
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count++;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}
export function tail(str, maxLen) {
    return maxLen > 0 && str.length > maxLen ? str.slice(-maxLen) : str;
}
export function resolveModel(taskModel, optModel, envModel) {
    return taskModel || optModel || envModel;
}
export function resolveReasoning(taskReasoning, optReasoning, envReasoning) {
    return taskReasoning || optReasoning || envReasoning;
}
//# sourceMappingURL=CodingAgent.js.map