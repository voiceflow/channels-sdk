// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in Instagram, end to end on this machine: Chat SDK's real
// Instagram adapter and the core's agent, against a stand-in for Instagram
// (./stand-in.mjs) and a scripted Voiceflow runtime. Every channel runs the
// same conversation.
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelContract } from '@voiceflow/channelkit/testing';
import * as commands from '../dist/connect/index.js';
import { CONTEXT_VARIABLES, instagram } from '../dist/index.js';
import { start } from './stand-in.mjs';

channelContract({ slug: 'instagram', channel: instagram, variables: CONTEXT_VARIABLES, commands, start, state: createMemoryState });
