// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in Linear, end to end on this machine: Chat SDK's real
// Linear adapter and the core's agent, against a stand-in for Linear
// (./stand-in.mjs) and a scripted Voiceflow runtime. Every channel runs the
// same conversation.
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelContract } from '@voiceflow/channels-sdk/testing';
import * as commands from '../dist/connect/index.js';
import { CONTEXT_VARIABLES, linear } from '../dist/index.js';
import { start } from './stand-in.mjs';

channelContract({ slug: 'linear', channel: linear, variables: CONTEXT_VARIABLES, commands, start, state: createMemoryState });
