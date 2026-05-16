# CaseGraph Demo Concept

CaseGraph is the reference use case for GraphVault: an investigation and case-management application where the important data is the graph itself.

The domain contains people, companies, accounts, payments, documents, events, notes, hypotheses, and tasks. These objects do not form a neat tree. A payment can belong to an account, support a hypothesis, appear in several timeline events, and be attached to several investigator notes. A person can be a customer, a signatory, a witness, and a related party in different parts of the same case.

This is the kind of data that can be stored in tables, but where the application often spends most of its energy rebuilding the object graph that users actually navigate.

## What The Demo Shows

- Bounded graph loading for API responses such as "show two hops around this payment".
- Object identity across several direct parents.
- Transactional case actions such as escalation, note creation, hypothesis updates, and evidence linking.
- GVQL insight queries over the committed graph.
- Persistent indexes for status, risk, owner, and domain IDs.
- Health, verification, schema migration metadata, and audit-friendly transaction metadata.
- GraphVault Studio as the operational companion for search, inspection, verification, backup, and repair.

## Why This Is A Good Fit

Case management is not just CRUD over independent rows. Users follow relationships, ask partial graph questions, change several related objects together, and need an audit trail for why state moved.

GraphVault is attractive here because the application can keep a rich TypeScript model in memory, commit it explicitly, query it as a graph, and expose only bounded subgraphs to the frontend instead of flattening and rehydrating everything on every request.

## What It Should Prove

The demo should not be a static viewer. It should let a developer perform real work:

- add a note to a payment
- link evidence to a hypothesis
- escalate a case with a reason
- change a hypothesis status
- run a GVQL insight query
- inspect the same store in GraphVault Studio
- reload the app and see the committed graph intact

That makes the value proposition visible: GraphVault is strongest where the domain model is a connected, audited, application-owned object graph.
