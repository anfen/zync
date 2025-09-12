import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        name: 'zync',
        globals: true,
        environment: 'happy-dom',
        dir: '.',
        setupFiles: ['./vitest.setup.ts'],
        coverage: {
            include: ['**/src/**/*.{ts,tsx}'],
            allowExternal: true,
            reportOnFailure: true,
            reporter: ['text', 'json-summary', 'json', 'html'],
        },
    },
});
