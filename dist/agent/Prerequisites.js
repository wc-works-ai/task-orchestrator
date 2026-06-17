export class Prerequisites {
    static async check(agent) {
        return [Prerequisites.checkNode(), ...(agent ? agent.checkPrerequisites() : [])];
    }
    static checkNode() {
        const v = process.version;
        /* v8 ignore next: ?? fallback for undefined array index */
        const major = parseInt(v.slice(1).split('.')[0] ?? '0', 10);
        return { name: 'node', ok: major >= 22, message: `Node ${v} (need >=22)` };
    }
    static format(results) {
        const lines = results.map(r => `  ${r.ok ? '✅' : '❌'} ${r.name}: ${r.message}`);
        const failed = results.filter(r => !r.ok);
        if (failed.length > 0) {
            lines.push(`\n  ${failed.length} issue(s) found. Fix before running.`);
        }
        return lines.join('\n');
    }
}
//# sourceMappingURL=Prerequisites.js.map