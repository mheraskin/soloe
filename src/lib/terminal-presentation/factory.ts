import type { SoloeTransportKind } from '@shared/api-contract.js';
import { LibghosttyTerminalPresentationAdapter } from './libghostty';
import type { NativeTerminalHost } from './native-host';
import type {
  TerminalPresentation,
  TerminalPresentationCreateRequest,
  TerminalPresentationFactory,
  TerminalPresentationPreference
} from './types';

type PresentationConstructor = (
  request: TerminalPresentationCreateRequest
) => TerminalPresentation | Promise<TerminalPresentation>;

export interface TerminalPresentationFactoryOptions {
  preference: TerminalPresentationPreference;
  transport: SoloeTransportKind;
  nativeHost?: NativeTerminalHost | null;
  createXterm?: PresentationConstructor;
  createLibghostty?: (
    host: NativeTerminalHost,
    request: TerminalPresentationCreateRequest
  ) => Promise<TerminalPresentation>;
}

export interface RuntimeTerminalPresentationFactoryOptions {
  preference: TerminalPresentationPreference;
  transport: SoloeTransportKind;
}

/** Selects a complete Adapter and makes native failure transparent to the PTY. */
export class ConfigurableTerminalPresentationFactory implements TerminalPresentationFactory {
  private readonly createXterm: PresentationConstructor;
  private readonly createLibghostty: NonNullable<
    TerminalPresentationFactoryOptions['createLibghostty']
  >;

  constructor(private readonly options: TerminalPresentationFactoryOptions) {
    this.createXterm = options.createXterm
      ?? (async (request) => {
        const { XtermTerminalPresentationAdapter } = await import('./xterm');
        return new XtermTerminalPresentationAdapter(request);
      });
    this.createLibghostty = options.createLibghostty
      ?? ((host, request) => LibghosttyTerminalPresentationAdapter.create(host, request));
  }

  async create(request: TerminalPresentationCreateRequest): Promise<TerminalPresentation> {
    if (!this.shouldTryNative()) return this.createXterm(request);
    const nativeHost = this.options.nativeHost;
    if (!nativeHost) return this.fallback(request, 'native terminal host is unavailable');

    try {
      const capabilities = await nativeHost.capabilities();
      if (!capabilities.available || !capabilities.complete) {
        return this.fallback(
          request,
          capabilities.reason ?? 'native terminal host did not report complete initialization'
        );
      }
      return await this.createLibghostty(nativeHost, request);
    } catch (error) {
      return this.fallback(request, error);
    }
  }

  private shouldTryNative(): boolean {
    return this.options.transport === 'tauri'
      && this.options.preference !== 'xterm';
  }

  private fallback(
    request: TerminalPresentationCreateRequest,
    error: unknown
  ): TerminalPresentation | Promise<TerminalPresentation> {
    request.callbacks.onRendererFailure?.({
      renderer: 'native',
      error,
      recovered: true
    });
    return this.createXterm(request);
  }
}

export async function resolveNativeTerminalHost(
  transport: SoloeTransportKind
): Promise<NativeTerminalHost | null> {
  if (transport !== 'tauri') return null;
  try {
    const { tauriNativeTerminalHost } = await import('./tauri-native-host');
    return tauriNativeTerminalHost;
  } catch {
    return null;
  }
}

/** Builds the shell-neutral factory without exposing native host selection to UI callers. */
export async function createTerminalPresentationFactory(
  options: RuntimeTerminalPresentationFactoryOptions
): Promise<TerminalPresentationFactory> {
  return new ConfigurableTerminalPresentationFactory({
    ...options,
    nativeHost: await resolveNativeTerminalHost(options.transport)
  });
}
