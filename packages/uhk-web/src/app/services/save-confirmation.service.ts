import { Injectable } from '@angular/core';
import { catchError, defaultIfEmpty, defer, finalize, map, Observable, of, take, withLatestFrom } from 'rxjs';
import type { UserConfigurationJson } from '../mcp/config-diff.js';
import { diffUserConfigurationWithRiskFlags, type FlaggedConfigDiffEntry } from '../mcp/risk-flags.js';

type Review = (changes: FlaggedConfigDiffEntry[]) => Observable<boolean>;
type SaveApproval = 'approved' | 'cancelled' | 'reviewRequired';

export function getSaveConfirmationChanges(
    baseline: UserConfigurationJson | undefined, current: UserConfigurationJson,
): FlaggedConfigDiffEntry[] {
    // A backup or recovery configuration may be written without a known keyboard baseline.
    const before = baseline ?? { ...current, keymaps: [], macros: [] };
    return diffUserConfigurationWithRiskFlags(before, current).flatMap(change => {
        const riskFlags = change.riskFlags.filter(flag => flag === 'runsWithoutKeyPress' || flag === 'opensLauncherOrShell');
        return riskFlags.length ? [{ ...change, riskFlags }] : [];
    });
}

@Injectable({ providedIn: 'root' })
export class SaveConfirmationService {
    private review?: Review;
    private reviewing = false;

    registerReview(review: Review): void {
        this.review = review;
    }

    unregisterReview(): void {
        this.review = undefined;
    }

    authorize(changes: FlaggedConfigDiffEntry[], stillCurrent$: Observable<boolean>): Observable<SaveApproval> {
        return defer(() => {
            if (!changes.length) {
                return of<SaveApproval>('approved');
            }
            const review = this.review;
            if (!review || this.reviewing) {
                return of<SaveApproval>('reviewRequired');
            }

            this.reviewing = true;
            return defer(() => review(changes)).pipe(
                take(1),
                withLatestFrom(stillCurrent$),
                map(([confirmed, stillCurrent]): SaveApproval => {
                    if (!confirmed) {
                        return 'cancelled';
                    }
                    return stillCurrent && this.review === review ? 'approved' : 'reviewRequired';
                }),
                defaultIfEmpty<SaveApproval, SaveApproval>('reviewRequired'),
                catchError(() => of<SaveApproval>('reviewRequired')),
                finalize(() => this.reviewing = false),
            );
        });
    }
}
