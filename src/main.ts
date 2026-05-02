import { mount } from 'svelte';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app root element');

mount(App, { target });
