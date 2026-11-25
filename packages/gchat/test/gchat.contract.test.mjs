// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in Google Chat, end to end on this machine: Chat SDK's real
// Google Chat adapter and the core's agent, against a stand-in for Google Chat
// (./stand-in.mjs) and a scripted Voiceflow runtime. Every channel runs the
// same conversation.
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelContract } from '@voiceflow/channels-sdk/testing';
import * as commands from '../dist/connect/index.js';
import { CONTEXT_VARIABLES, gchat } from '../dist/index.js';
import { start } from './stand-in.mjs';

channelContract({ slug: 'gchat', channel: gchat, variables: CONTEXT_VARIABLES, commands, start, state: createMemoryState });
