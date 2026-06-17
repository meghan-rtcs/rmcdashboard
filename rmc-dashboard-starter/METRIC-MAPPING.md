# RMC Dashboard — Metric Mapping

Every metric from the Limehouse dashboard, mapped to its AppFolio data source and SQL calculation.
Use this as the blueprint for the aggregator.

## Branding
- Company: Real Management Company (RMC)
- Primary: #F5A623 (gold/orange from logo)
- Dark: #1A1A1A (black)
- Accent: #D48B1A (darker gold for hover states)
- Light bg: #FFF8EE (warm off-white)
- Text: #1A1A1A
- Muted: #6B6B6B

## OCCUPANCY SECTION

| Metric | Limehouse Source | RMC: AF Table | SQL |
|---|---|---|---|
| Occupancy Rate | Buildium leases | `units` | `SELECT COUNT(CASE WHEN occupancy_status IN ('Occupied','Current') THEN 1 END) * 100.0 / COUNT(*) FROM units` |
| Total Units | Buildium properties | `units` | `SELECT COUNT(*) FROM units` |
| Vacant Not Rented | Buildium lease status | `units` | `SELECT COUNT(*) FROM units WHERE occupancy_status LIKE '%Vacant%' AND lease_to < date('now')` |
| Vacant Rented | Buildium lease status | `units` | `SELECT COUNT(*) FROM units WHERE occupancy_status LIKE '%Vacant%' AND lease_to >= date('now')` |
| Avg Days Vacant | Buildium dates | `vacancies` | `SELECT AVG(days_vacant) FROM vacancies` |
| Total Properties | Buildium | `properties` | `SELECT COUNT(*) FROM properties` |
| Total Owners | Buildium | `owners` | `SELECT COUNT(*) FROM owners` |

## LEASING SECTION

| Metric | Limehouse Source | RMC: AF Table | SQL |
|---|---|---|---|
| Renewal Rate | Buildium + LS | `renewals` | `SELECT COUNT(CASE WHEN renewal_status='Renewed' THEN 1 END) * 100.0 / COUNT(*) FROM renewals WHERE lease_end >= date('now','-12 months')` |
| MTM Leases | Buildium | `renewals` or `units` | Count where renewal_status='Month To Month' or lease_to is past with no move_out |
| Fixed Leases | Buildium | `units` | Count where lease_to is in the future |
| Apps Submitted | Buildium applicants | `applications` | `SELECT COUNT(*) FROM applications WHERE received_date >= date('now','-12 months')` |
| Move-ins | Buildium | `units` | `SELECT COUNT(*) FROM units WHERE move_in_date >= date('now','-12 months')` |
| Apps per Move-in | Calculated | | apps_submitted / move_ins |
| Showing Completion Rate | **RentEngine** → **AF showings** | `showings` | `SELECT COUNT(CASE WHEN status='Completed' THEN 1 END) * 100.0 / COUNT(CASE WHEN status NOT IN ('Canceled','Prospect Canceled','Canceled (Unconfirmed)') THEN 1 END) FROM showings` |
| Total Showings | **RentEngine** → **AF showings** | `showings` | `SELECT COUNT(*) FROM showings WHERE showing_date >= date('now','-30 days')` |
| No-Shows | **RentEngine** → **AF showings** | `showings` | `SELECT COUNT(*) FROM showings WHERE status='No Show'` |

## MARKETING / FUNNEL SECTION (was RentEngine, now AppFolio)

| Metric | RMC: AF Table | SQL |
|---|---|---|
| Inquiries (Guest Cards) | `guest_cards` | `SELECT COUNT(*) FROM guest_cards WHERE received_date >= date('now','-30 days')` |
| Inquiries by Source | `guest_cards` | `GROUP BY source` |
| Active Prospects | `guest_cards` | `WHERE status IN ('active','prequalified','waitlisted')` |
| Showings Scheduled | `showings` | `WHERE status='Scheduled'` |
| Showings Completed | `showings` | `WHERE status='Completed'` |
| Applications | `applications` | `WHERE received_date >= date('now','-30 days')` |
| Approved | `applications` | `WHERE status='Approved'` |
| Converted (Leased) | `applications` | `WHERE status='Converted'` |
| Units on Market | `vacancies` | `SELECT COUNT(*) FROM vacancies` |

## FINANCIALS

| Metric | Limehouse Source | RMC: AF Endpoint | Notes |
|---|---|---|---|
| Gross Income (YTD) | Buildium GL | `income_statement.json` | Sum of income account MTD/YTD |
| Net Income (YTD) | Buildium GL | `income_statement.json` | Income minus expenses |
| Monthly Revenue/Expense | Buildium GL | `income_statement_12_month.json` | 12-month trend |
| Delinquent Total | Buildium delinquency | `delinquency` table | `SELECT SUM(amount_receivable) FROM delinquency` |
| Delinquent Count | Buildium delinquency | `delinquency` table | `SELECT COUNT(*) FROM delinquency WHERE amount_receivable > 0` |
| Delinquency Rate | Calculated | | delinquent_total / total_rent_roll |
| 30/60/90+ Aging | Buildium | `delinquency` | SUM of thirty_plus, sixty_plus, ninety_plus columns |
| Avg Rent per Door | Buildium | `units` | `SELECT AVG(current_rent) FROM units WHERE current_rent > 0` |
| Revenue per Unit | Buildium GL | `income_statement.json` | total_income / total_units |

## MAINTENANCE

| Metric | RMC: AF Table | SQL |
|---|---|---|
| Open Work Orders | `work_orders` | `WHERE status NOT IN ('Completed','Canceled','Completed No Need To Bill')` |
| Avg Days to Complete | `work_orders` | `AVG(julianday(completed_date) - julianday(created_date))` where completed |
| WOs by Priority | `work_orders` | `GROUP BY priority` |
| WOs by Type | `work_orders` | `GROUP BY work_order_type` |
| Unit Turns in Progress | AF `unit_turn_detail.json` | Sync separately if needed |

## REMOVED (LeadSimple)
- Task Completion Rate
- Workflow Compliance
- All LeadSimple KPIs
- Team Performance tab (no equivalent in AF without LS)

## KEPT FROM RENTENGINE (now powered by AppFolio)
- Showing data → `showings.json`
- Lead/prospect data → `guest_card_inquiries.json`
- Leasing funnel → `leasing_funnel_performance.json`
- Source tracking → `prospect_source_tracking.json`
