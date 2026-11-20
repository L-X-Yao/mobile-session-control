#!/usr/bin/env node
// Validate provider profile files or directories without contacting a provider.
import fs from 'node:fs';
import path from 'node:path';
import {
    isPlaceholderModel, loadProfileFile, loadProfilesDirectory, ProfileValidationError,
} from './schema.mjs';

function expand(targets) {
    const profiles = [];
    for (const target of targets) {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
            profiles.push(...loadProfilesDirectory(target));
        } else {
            profiles.push(loadProfileFile(target));
        }
    }
    return profiles;
}

function main(argv) {
    if (argv.length === 0) {
        process.stderr.write('usage: validate-cli.mjs <profile.json|directory>...\n');
        process.exit(2);
    }
    let profiles;
    try {
        profiles = expand(argv);
    } catch (error) {
        if (error instanceof ProfileValidationError) {
            process.stderr.write(`${error.message}\n`);
            process.exit(1);
        }
        throw error;
    }
    for (const profile of profiles) {
        const suffix = isPlaceholderModel(profile) ? ' (template)' : '';
        process.stdout.write(`OK ${profile.id} ${profile.model}${suffix}\n`);
    }
}

main(process.argv.slice(2));
