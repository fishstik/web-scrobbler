import { mockedBrowser } from '#/mock/MockedBrowser';
import * as webExt from 'webextension-polyfill-ts';

// @ts-ignore
webExt.browser = mockedBrowser as webExt.Browser;
