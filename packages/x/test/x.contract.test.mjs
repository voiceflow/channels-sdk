// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in X, end to end on this machine: Chat SDK's real
// X adapter and the core's agent, against a stand-in for X
// (./stand-in.mjs) and a scripted Voiceflow runtime. Every channel runs the
// same conversation.
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelContract } from '@voiceflow/channelkit/testing';
import * as commands from '../dist/connect/index.js';
import { CONTEXT_VARIABLES, x } from '../dist/index.js';
import { start } from './stand-in.mjs';

channelContract({ slug: 'x', channel: x, variables: CONTEXT_VARIABLES, commands, start, state: createMemoryState });
