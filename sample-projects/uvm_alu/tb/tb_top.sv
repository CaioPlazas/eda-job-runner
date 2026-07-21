// UVM testbench top: clock/reset generation, DUT + interface instantiation,
// and run_test(). The DUT's bug_en is driven from a +BUG plusarg so the same
// test can be run against a good DUT (passes) or a deliberately broken one
// (the scoreboard flags real UVM_ERRORs) without changing any code.
`timescale 1ns/1ps
module tb_top;
    import uvm_pkg::*;
    import alu_pkg::*;
    `include "uvm_macros.svh"

    logic clk = 1'b0;
    always #5 clk = ~clk; // 100 MHz

    alu_if #(.W(32)) vif (.clk(clk));

    alu #(.W(32)) dut (
        .clk       (clk),
        .rst_n     (vif.rst_n),
        .in_valid  (vif.in_valid),
        .op        (vif.op),
        .a         (vif.a),
        .b         (vif.b),
        .bug_en    (vif.bug_en),
        .out_valid (vif.out_valid),
        .result    (vif.result)
    );

    // Reset + optional bug injection.
    initial begin
        bit bug;
        bug = $test$plusargs("BUG");
        vif.bug_en = bug;
        if (bug)
            `uvm_info("TB_TOP", "+BUG set: DUT SUB is intentionally broken", UVM_LOW)
        vif.rst_n = 1'b0;
        repeat (5) @(posedge clk);
        vif.rst_n = 1'b1;
    end

    // Hand the interface to the UVM environment and launch.
    initial begin
        uvm_config_db#(virtual alu_if)::set(null, "*", "vif", vif);
        run_test();
    end

    // Safety watchdog.
    initial begin
        #500_000;
        `uvm_fatal("TIMEOUT", "watchdog fired")
    end
endmodule
