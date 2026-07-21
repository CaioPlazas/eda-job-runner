// UVM verification environment for the ALU DUT.
//
// Structure (standard UVM layering):
//   alu_txn        - sequence item (op/a/b + captured result)
//   alu_driver     - drives one operation per cycle onto the interface
//   alu_monitor    - reconstructs completed operations from the interface,
//                    robust to the DUT's pipeline latency via an input queue
//   alu_scoreboard - independent reference model, flags mismatches as UVM_ERROR
//   alu_coverage   - functional coverage on the opcode
//   alu_agent/env  - wiring
//   sequences+tests
//
// Sampling is done on the negedge so all posedge non-blocking updates have
// settled — no clock-edge race, and portable across simulators.
package alu_pkg;
    import uvm_pkg::*;
    `include "uvm_macros.svh"

    localparam int W = 32;

    typedef enum bit [3:0] {
        OP_ADD = 4'd0, OP_SUB = 4'd1, OP_AND = 4'd2, OP_OR  = 4'd3,
        OP_XOR = 4'd4, OP_SLL = 4'd5, OP_SRL = 4'd6, OP_SLT = 4'd7
    } op_e;

    // ---------------------------------------------------------------- txn ---
    class alu_txn extends uvm_sequence_item;
        rand op_e         op;
        rand bit [W-1:0]  a;
        rand bit [W-1:0]  b;
        bit [W-1:0]       result; // filled in by the monitor

        `uvm_object_utils_begin(alu_txn)
            `uvm_field_enum(op_e, op, UVM_ALL_ON)
            `uvm_field_int(a, UVM_ALL_ON)
            `uvm_field_int(b, UVM_ALL_ON)
            `uvm_field_int(result, UVM_ALL_ON)
        `uvm_object_utils_end

        function new(string name = "alu_txn");
            super.new(name);
        endfunction

        // Reference model: the golden expected result for this operation.
        function bit [W-1:0] expected();
            case (op)
                OP_ADD: return a + b;
                OP_SUB: return a - b;
                OP_AND: return a & b;
                OP_OR:  return a | b;
                OP_XOR: return a ^ b;
                OP_SLL: return a << b[4:0];
                OP_SRL: return a >> b[4:0];
                OP_SLT: return { {(W-1){1'b0}}, ($signed(a) < $signed(b)) };
                default: return '0;
            endcase
        endfunction
    endclass

    typedef uvm_sequencer #(alu_txn) alu_sequencer;

    // ------------------------------------------------------------- driver ---
    class alu_driver extends uvm_driver #(alu_txn);
        `uvm_component_utils(alu_driver)
        virtual alu_if vif;

        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction

        function void build_phase(uvm_phase phase);
            super.build_phase(phase);
            if (!uvm_config_db#(virtual alu_if)::get(this, "", "vif", vif))
                `uvm_fatal("NOVIF", "alu_driver: no virtual interface set")
        endfunction

        task run_phase(uvm_phase phase);
            // Idle the stimulus lines.
            vif.in_valid <= 1'b0;
            vif.op       <= 4'd0;
            vif.a        <= '0;
            vif.b        <= '0;
            @(posedge vif.clk);
            forever begin
                alu_txn req;
                seq_item_port.get_next_item(req);
                @(posedge vif.clk);
                vif.in_valid <= 1'b1;
                vif.op       <= req.op;
                vif.a        <= req.a;
                vif.b        <= req.b;
                @(posedge vif.clk);
                vif.in_valid <= 1'b0;
                seq_item_port.item_done();
            end
        endtask
    endclass

    // ------------------------------------------------------------ monitor ---
    class alu_monitor extends uvm_monitor;
        `uvm_component_utils(alu_monitor)
        virtual alu_if vif;
        uvm_analysis_port #(alu_txn) ap;

        function new(string name, uvm_component parent);
            super.new(name, parent);
            ap = new("ap", this);
        endfunction

        function void build_phase(uvm_phase phase);
            super.build_phase(phase);
            if (!uvm_config_db#(virtual alu_if)::get(this, "", "vif", vif))
                `uvm_fatal("NOVIF", "alu_monitor: no virtual interface set")
        endfunction

        task run_phase(uvm_phase phase);
            op_e        in_op_q[$];
            bit [W-1:0] in_a_q[$];
            bit [W-1:0] in_b_q[$];
            forever begin
                @(negedge vif.clk);
                if (!vif.rst_n) begin
                    in_op_q.delete(); in_a_q.delete(); in_b_q.delete();
                    continue;
                end
                // Record each accepted stimulus...
                if (vif.in_valid) begin
                    in_op_q.push_back(op_e'(vif.op));
                    in_a_q.push_back(vif.a);
                    in_b_q.push_back(vif.b);
                end
                // ...and pair it with the result when it emerges (in order).
                if (vif.out_valid && in_op_q.size() > 0) begin
                    alu_txn t = alu_txn::type_id::create("t");
                    t.op     = in_op_q.pop_front();
                    t.a      = in_a_q.pop_front();
                    t.b      = in_b_q.pop_front();
                    t.result = vif.result;
                    ap.write(t);
                end
            end
        endtask
    endclass

    // --------------------------------------------------------- scoreboard ---
    class alu_scoreboard extends uvm_subscriber #(alu_txn);
        `uvm_component_utils(alu_scoreboard)
        int unsigned checked;
        int unsigned mismatches;

        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction

        function void write(alu_txn t);
            bit [W-1:0] exp = t.expected();
            checked++;
            if (t.result !== exp) begin
                mismatches++;
                `uvm_error("ALU_MISMATCH",
                    $sformatf("op=%s a=0x%08x b=0x%08x : DUT=0x%08x expected=0x%08x",
                              t.op.name(), t.a, t.b, t.result, exp))
            end else begin
                `uvm_info("ALU_OK",
                    $sformatf("op=%s a=0x%08x b=0x%08x -> 0x%08x", t.op.name(), t.a, t.b, t.result),
                    UVM_HIGH)
            end
        endfunction

        function void report_phase(uvm_phase phase);
            `uvm_info("SB", $sformatf("scoreboard: %0d checked, %0d mismatch(es)", checked, mismatches), UVM_LOW)
        endfunction
    endclass

    // ----------------------------------------------------------- coverage ---
    class alu_coverage extends uvm_subscriber #(alu_txn);
        `uvm_component_utils(alu_coverage)
        op_e sampled_op;

        covergroup cg;
            coverpoint sampled_op {
                bins ops[] = {OP_ADD, OP_SUB, OP_AND, OP_OR, OP_XOR, OP_SLL, OP_SRL, OP_SLT};
            }
        endgroup

        function new(string name, uvm_component parent);
            super.new(name, parent);
            cg = new();
        endfunction

        function void write(alu_txn t);
            sampled_op = t.op;
            cg.sample();
        endfunction
    endclass

    // -------------------------------------------------------------- agent ---
    class alu_agent extends uvm_agent;
        `uvm_component_utils(alu_agent)
        alu_driver    drv;
        alu_sequencer seqr;
        alu_monitor   mon;

        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction

        function void build_phase(uvm_phase phase);
            super.build_phase(phase);
            drv  = alu_driver::type_id::create("drv", this);
            seqr = alu_sequencer::type_id::create("seqr", this);
            mon  = alu_monitor::type_id::create("mon", this);
        endfunction

        function void connect_phase(uvm_phase phase);
            drv.seq_item_port.connect(seqr.seq_item_export);
        endfunction
    endclass

    // ---------------------------------------------------------------- env ---
    class alu_env extends uvm_env;
        `uvm_component_utils(alu_env)
        alu_agent      agent;
        alu_scoreboard sb;
        alu_coverage   cov;

        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction

        function void build_phase(uvm_phase phase);
            super.build_phase(phase);
            agent = alu_agent::type_id::create("agent", this);
            sb    = alu_scoreboard::type_id::create("sb", this);
            cov   = alu_coverage::type_id::create("cov", this);
        endfunction

        function void connect_phase(uvm_phase phase);
            agent.mon.ap.connect(sb.analysis_export);
            agent.mon.ap.connect(cov.analysis_export);
        endfunction
    endclass

    // ---------------------------------------------------------- sequences ---
    class alu_random_seq extends uvm_sequence #(alu_txn);
        `uvm_object_utils(alu_random_seq)
        rand int unsigned n = 200;

        function new(string name = "alu_random_seq");
            super.new(name);
        endfunction

        task body();
            repeat (n) begin
                alu_txn t = alu_txn::type_id::create("t");
                start_item(t);
                if (!t.randomize())
                    `uvm_error("RANDFAIL", "randomize failed")
                finish_item(t);
            end
        endtask
    endclass

    // Directed sequence: hit every opcode with a couple of corner operands.
    class alu_directed_seq extends uvm_sequence #(alu_txn);
        `uvm_object_utils(alu_directed_seq)

        function new(string name = "alu_directed_seq");
            super.new(name);
        endfunction

        task drive(op_e o, bit [W-1:0] a, bit [W-1:0] b);
            alu_txn t = alu_txn::type_id::create("t");
            start_item(t);
            t.op = o; t.a = a; t.b = b;
            finish_item(t);
        endtask

        task body();
            op_e ops[] = '{OP_ADD, OP_SUB, OP_AND, OP_OR, OP_XOR, OP_SLL, OP_SRL, OP_SLT};
            foreach (ops[i]) begin
                drive(ops[i], 32'h0000_0000, 32'h0000_0000);
                drive(ops[i], 32'hFFFF_FFFF, 32'h0000_0001);
                drive(ops[i], 32'h8000_0000, 32'h7FFF_FFFF);
                drive(ops[i], 32'hDEAD_BEEF, 32'h0000_0004);
            end
        endtask
    endclass

    // -------------------------------------------------------------- tests ---
    class alu_base_test extends uvm_test;
        `uvm_component_utils(alu_base_test)
        alu_env env;

        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction

        function void build_phase(uvm_phase phase);
            super.build_phase(phase);
            env = alu_env::type_id::create("env", this);
        endfunction

        function void end_of_elaboration_phase(uvm_phase phase);
            uvm_top.print_topology();
        endfunction
    endclass

    // Directed corners, then a randomized burst.
    class alu_random_test extends alu_base_test;
        `uvm_component_utils(alu_random_test)

        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction

        task run_phase(uvm_phase phase);
            alu_directed_seq dseq;
            alu_random_seq   rseq;
            phase.raise_objection(this);
            dseq = alu_directed_seq::type_id::create("dseq");
            dseq.start(env.agent.seqr);
            rseq = alu_random_seq::type_id::create("rseq");
            void'(rseq.randomize() with { n == 300; });
            rseq.start(env.agent.seqr);
            // Let the pipeline drain.
            repeat (10) @(posedge env.agent.mon.vif.clk);
            phase.drop_objection(this);
        endtask
    endclass

    // Shorter directed-only smoke test.
    class alu_smoke_test extends alu_base_test;
        `uvm_component_utils(alu_smoke_test)

        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction

        task run_phase(uvm_phase phase);
            alu_directed_seq dseq;
            phase.raise_objection(this);
            dseq = alu_directed_seq::type_id::create("dseq");
            dseq.start(env.agent.seqr);
            repeat (10) @(posedge env.agent.mon.vif.clk);
            phase.drop_objection(this);
        endtask
    endclass
endpackage
