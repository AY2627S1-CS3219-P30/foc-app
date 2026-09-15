"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import {
  INITIAL_BALANCE,
  INITIAL_LEDGER,
  INITIAL_RESERVED,
  INITIAL_REQUESTS,
  SUPPLIERS,
} from "./mock-data";
import { CURRENT_USER, type ErrandRequest, type LedgerEntry, type Supplier } from "./types";

type State = {
  isAuthenticated: boolean;
  isMenuOpen: boolean;
  requests: ErrandRequest[];
  ledger: LedgerEntry[];
  balance: number;
  reserved: number;
  suppliers: Supplier[];
};

type NewRequestInput = {
  title: string;
  supplier: string;
  dropoff: string;
  description: string;
  credits: number;
};

type Action =
  | { type: "LOGIN" }
  | { type: "LOGOUT" }
  | { type: "SET_MENU_OPEN"; open: boolean }
  | { type: "CREATE_REQUEST"; id: string; input: NewRequestInput }
  | { type: "EDIT_REQUEST"; id: string; input: NewRequestInput }
  | { type: "ACCEPT_REQUEST"; id: string }
  | { type: "COMPLETE_REQUEST"; id: string }
  | { type: "CANCEL_REQUEST"; id: string }
  | { type: "RELEASE_REQUEST"; id: string };

const initialState: State = {
  isAuthenticated: false,
  isMenuOpen: false,
  requests: INITIAL_REQUESTS,
  ledger: INITIAL_LEDGER,
  balance: INITIAL_BALANCE,
  reserved: INITIAL_RESERVED,
  suppliers: SUPPLIERS,
};

// Not a module-level counter: a reducer must stay pure (no shared mutable
// state), since React's Strict Mode double-invokes reducers in dev to
// catch exactly this kind of bug — a counter would drift on every
// dispatch. crypto.randomUUID() has no such shared state to corrupt.
function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "LOGIN":
      return { ...state, isAuthenticated: true };

    case "LOGOUT":
      return { ...state, isAuthenticated: false, isMenuOpen: false };

    case "SET_MENU_OPEN":
      return { ...state, isMenuOpen: action.open };

    case "CREATE_REQUEST": {
      const { input } = action;
      const request: ErrandRequest = {
        id: action.id,
        title: input.title,
        supplier: input.supplier,
        dropoff: input.dropoff,
        description: input.description,
        credits: input.credits,
        status: "open",
        requesterId: CURRENT_USER.id,
        requesterName: CURRENT_USER.name,
        expiryLabel: "Expires in 60 min",
        createdAt: Date.now(),
      };
      const ledgerEntry: LedgerEntry = {
        id: makeId("l"),
        type: "reserved",
        label: "Credits reserved",
        detail: input.title,
        amount: -input.credits,
        createdAt: Date.now(),
      };
      return {
        ...state,
        requests: [request, ...state.requests],
        ledger: [ledgerEntry, ...state.ledger],
        balance: state.balance - input.credits,
        reserved: state.reserved + input.credits,
      };
    }

    case "EDIT_REQUEST": {
      const existing = state.requests.find((r) => r.id === action.id);
      if (!existing || existing.requesterId !== CURRENT_USER.id || existing.status !== "open") {
        return state;
      }
      const creditDelta = action.input.credits - existing.credits;
      return {
        ...state,
        requests: state.requests.map((r) =>
          r.id === action.id ? { ...r, ...action.input } : r
        ),
        balance: state.balance - creditDelta,
        reserved: state.reserved + creditDelta,
      };
    }

    case "ACCEPT_REQUEST": {
      const existing = state.requests.find((r) => r.id === action.id);
      if (!existing || existing.status !== "open" || existing.requesterId === CURRENT_USER.id) {
        return state;
      }
      return {
        ...state,
        requests: state.requests.map((r) =>
          r.id === action.id
            ? { ...r, status: "in_transit", courierId: CURRENT_USER.id, courierName: CURRENT_USER.name }
            : r
        ),
      };
    }

    case "COMPLETE_REQUEST": {
      const existing = state.requests.find((r) => r.id === action.id);
      if (!existing || existing.status !== "in_transit" || existing.courierId !== CURRENT_USER.id) {
        return state;
      }
      const ledgerEntry: LedgerEntry = {
        id: makeId("l"),
        type: "earned",
        label: "Errand completed",
        detail: existing.title,
        amount: existing.credits,
        createdAt: Date.now(),
      };
      return {
        ...state,
        requests: state.requests.map((r) =>
          r.id === action.id ? { ...r, status: "complete" } : r
        ),
        ledger: [ledgerEntry, ...state.ledger],
        balance: state.balance + existing.credits,
      };
    }

    case "CANCEL_REQUEST": {
      const existing = state.requests.find((r) => r.id === action.id);
      const cancellable = existing?.status === "open" || existing?.status === "in_transit";
      if (!existing || existing.requesterId !== CURRENT_USER.id || !cancellable) {
        return state;
      }
      const ledgerEntry: LedgerEntry = {
        id: makeId("l"),
        type: "released",
        label: "Credits released",
        detail: existing.title,
        amount: existing.credits,
        createdAt: Date.now(),
      };
      return {
        ...state,
        requests: state.requests.map((r) =>
          r.id === action.id ? { ...r, status: "cancelled" } : r
        ),
        ledger: [ledgerEntry, ...state.ledger],
        balance: state.balance + existing.credits,
        reserved: state.reserved - existing.credits,
      };
    }

    case "RELEASE_REQUEST": {
      // Courier backs out before delivering — the errand goes back to
      // open for someone else to accept. No credits move: the courier
      // was never paid, and the requester's reservation is untouched.
      const existing = state.requests.find((r) => r.id === action.id);
      if (!existing || existing.status !== "in_transit" || existing.courierId !== CURRENT_USER.id) {
        return state;
      }
      return {
        ...state,
        requests: state.requests.map((r) =>
          r.id === action.id
            ? { ...r, status: "open", courierId: undefined, courierName: undefined }
            : r
        ),
      };
    }

    default:
      return state;
  }
}

type Store = {
  state: State;
  login: () => void;
  logout: () => void;
  setMenuOpen: (open: boolean) => void;
  createRequest: (input: NewRequestInput) => string;
  editRequest: (id: string, input: NewRequestInput) => void;
  acceptRequest: (id: string) => void;
  completeRequest: (id: string) => void;
  cancelRequest: (id: string) => void;
  releaseRequest: (id: string) => void;
};

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const login = useCallback(() => dispatch({ type: "LOGIN" }), []);
  const logout = useCallback(() => dispatch({ type: "LOGOUT" }), []);
  const setMenuOpen = useCallback((open: boolean) => dispatch({ type: "SET_MENU_OPEN", open }), []);
  const createRequest = useCallback((input: NewRequestInput) => {
    const id = makeId("r");
    dispatch({ type: "CREATE_REQUEST", id, input });
    return id;
  }, []);
  const editRequest = useCallback(
    (id: string, input: NewRequestInput) => dispatch({ type: "EDIT_REQUEST", id, input }),
    []
  );
  const acceptRequest = useCallback((id: string) => dispatch({ type: "ACCEPT_REQUEST", id }), []);
  const completeRequest = useCallback((id: string) => dispatch({ type: "COMPLETE_REQUEST", id }), []);
  const cancelRequest = useCallback((id: string) => dispatch({ type: "CANCEL_REQUEST", id }), []);
  const releaseRequest = useCallback((id: string) => dispatch({ type: "RELEASE_REQUEST", id }), []);

  const value = useMemo(
    () => ({
      state,
      login,
      logout,
      setMenuOpen,
      createRequest,
      editRequest,
      acceptRequest,
      completeRequest,
      cancelRequest,
      releaseRequest,
    }),
    [
      state,
      login,
      logout,
      setMenuOpen,
      createRequest,
      editRequest,
      acceptRequest,
      completeRequest,
      cancelRequest,
      releaseRequest,
    ]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
