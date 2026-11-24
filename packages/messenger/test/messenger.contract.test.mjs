// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in Messenger, end to end on this machine: Chat SDK's real
// Messenger adapter and the core's agent, against a stand-in for Messenger
// (./stand-in.mjs) and a scripted Voiceflow runtime. Every channel runs the
// same conversation.
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelContract } from '@voiceflow/channels-sdk/testing';
import * as commands from '../dist/connect/index.js';
import { CONTEXT_VARIABLES, messenger } from '../dist/index.js';
import { start } from './stand-in.mjs';

channelContract({ slug: 'messenger', channel: messenger, variables: CONTEXT_VARIABLES, commands, start, state: createMemoryState });
