import { mount } from 'svelte';
import '@fontsource-variable/inter/index.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/cascadia-code/400.css';
import '@fontsource/cascadia-code/700.css';
import '../app.css';
import TauriBenchmarkApp from './TauriBenchmarkApp.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app root element');

mount(TauriBenchmarkApp, { target });
performance.mark('soloe:tauri-renderer-mounted');
